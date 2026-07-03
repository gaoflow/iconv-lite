"use strict"

const Buffer = require("buffer").Buffer

/**
 * Node.js-compatible "internal" codecs: UTF-8, CESU-8 and the byte-string transports binary
 * (latin1), base64 and hex. Their semantics deliberately match Node's Buffer built-ins so that
 * iconv-lite can be used as a drop-in replacement for Buffer-based conversions.
 *
 * Note the direction of the byte-string transports (binary/base64/hex): encode() parses the
 * *textual representation* into bytes and decode() serializes bytes back into that representation,
 * mirroring Buffer.from(str, enc) / buf.toString(enc).
 */

/**
 * UTF-8 codec.
 *
 * Decoding uses the WHATWG-standard TextDecoder (available in both Node and browsers), so it
 * conforms to the Encoding Standard's "UTF-8 decode": ill-formed sequences (RFC 3629 / Unicode
 * Standard, Section 3.9, definition D92) are replaced with U+FFFD following the maximal-subpart
 * rule, or throw with { fatal: true }. Streaming (sequences split across chunks) is handled by
 * TextDecoder itself.
 *
 * Encoding produces well-formed UTF-8: a lone (unpaired) surrogate is replaced with U+FFFD, the
 * same result as the WHATWG "UTF-8 encode" of a USVString. The encoder is streaming-safe: a
 * surrogate pair split across two write() calls is held over and encoded whole.
 */
class Utf8Codec {
  createEncoder (options, iconv) { return new Utf8Encoder() }
  createDecoder (options, iconv) { return new Utf8Decoder(options) }
  get bomAware () { return true }
}

/**
 * CESU-8 codec (Unicode Technical Report #26, "Compatibility Encoding Scheme for UTF-16: 8-Bit").
 * Every UTF-16 code unit -- including each half of a surrogate pair -- is encoded in the 1..3-byte
 * UTF-8 byte pattern, so supplementary characters take 6 bytes (two 3-byte sequences) instead of
 * UTF-8's 4.
 */
class Cesu8Codec {
  createEncoder (options, iconv) { return new Cesu8Encoder() }
  createDecoder (options, iconv) { return new Cesu8Decoder(iconv.defaultCharUnicode) }
  get bomAware () { return true }
}

/**
 * Binary codec, an alias of Node's "binary"/"latin1" Buffer encoding: byte value <-> code point
 * (the ISO-8859-1 identity mapping, U+0000..U+00FF). This is intentionally NOT the WHATWG "latin1"
 * label, which resolves to windows-1252; that one is served by the sbcs tables.
 */
class BinaryCodec {
  createEncoder (options, iconv) { return new RawEncoder("binary") }
  createDecoder (options, iconv) { return new BufferedStringDecoder("binary") }
}

/**
 * Base64 codec (RFC 4648, Section 4), with Node Buffer's forgiving parser: non-alphabet bytes
 * (whitespace etc.) are ignored and an incomplete trailing quantum is truncated. The encoder is
 * streaming-safe: it only feeds whole 4-char quanta to the parser and carries the tail over to the
 * next write().
 */
class Base64Codec {
  createEncoder (options, iconv) { return new Base64Encoder() }
  createDecoder (options, iconv) { return new BufferedStringDecoder("base64") }
}

/**
 * Hex codec (RFC 4648, Section 8, "Base16"), matching Node Buffer's semantics: decoding emits
 * lowercase hex; encoding parses hex pairs and stops at the first invalid or incomplete pair.
 */
class HexCodec {
  createEncoder (options, iconv) { return new RawEncoder("hex") }
  createDecoder (options, iconv) { return new BufferedStringDecoder("hex") }
}

/**
 * UTF-8 encoder. Delegates the conversion to Buffer.from(str, "utf8"), which encodes each Unicode
 * scalar value per RFC 3629 and replaces a lone surrogate with U+FFFD. The only state is chunk
 * stitching: a high surrogate at the very end of a write() may be the first half of a pair whose
 * low half arrives in the next chunk, so it is held back instead of being encoded (ill-formed) now.
 */
class Utf8Encoder {
  constructor () {
    this.highSurrogate = ""
  }

  /**
   * @param {string} str
   * @returns {Buffer}
   */
  write (str) {
    if (this.highSurrogate) {
      str = this.highSurrogate + str
      this.highSurrogate = ""
    }

    if (str.length > 0) {
      const code = str.charCodeAt(str.length - 1)
      if (code >= 0xD800 && code < 0xDC00) {
        this.highSurrogate = str[str.length - 1]
        str = str.slice(0, str.length - 1)
      }
    }

    return Buffer.from(str, "utf8")
  }

  /** @returns {Buffer|undefined} U+FFFD (as EF BF BD) for a high surrogate left unpaired at end of input. */
  end () {
    if (this.highSurrogate) {
      const str = this.highSurrogate
      this.highSurrogate = ""
      return Buffer.from(str, "utf8")
    }
  }
}

/**
 * UTF-8 decoder: a thin wrapper over the WHATWG TextDecoder, which implements the Encoding
 * Standard's UTF-8 decoder (streaming, U+FFFD replacement and { fatal } are all native).
 *
 * BOM handling: by default TextDecoder consumes a leading BOM itself (ignoreBOM: false). When the
 * caller opts out of stripping (stripBOM: false) or wants to observe it (stripBOM: callback), the
 * BOM must reach iconv-lite's StripBOM wrapper instead, so the TextDecoder is told to leave it in.
 */
class Utf8Decoder {
  /** @param {{fatal?: boolean, stripBOM?: boolean|Function}} [options] */
  constructor (options) {
    this.decoder = new TextDecoder("utf8", {
      ignoreBOM: !!options && (options.stripBOM === false || typeof options.stripBOM === "function"),
      fatal: !!(options && options.fatal)
    })
  }

  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string}
   */
  write (buf) {
    return this.decoder.decode(buf, { stream: true })
  }

  /** @returns {string|undefined} U+FFFD for a sequence left truncated at end of input (or throws when fatal). */
  end () {
    const res = this.decoder.decode()
    return res.length > 0 ? res : undefined
  }
}

/**
 * CESU-8 encoder (UTR #26). Encodes each UTF-16 code unit independently in the UTF-8 byte pattern:
 * 1 byte for U+0000..U+007F, 2 bytes for U+0080..U+07FF, 3 bytes for U+0800..U+FFFF. Surrogate
 * halves are just code units here (0xD800..0xDFFF -> 3-byte form), which is exactly what makes it
 * CESU-8 rather than UTF-8. No state is needed: a pair split across chunks encodes the same way.
 */
class Cesu8Encoder {
  /**
   * @param {string} str
   * @returns {Buffer}
   */
  write (str) {
    const buf = Buffer.alloc(str.length * 3)
    let bufIdx = 0
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i)
      if (charCode < 0x80) {
        buf[bufIdx++] = charCode
      } else if (charCode < 0x800) {
        buf[bufIdx++] = 0xC0 + (charCode >>> 6)
        buf[bufIdx++] = 0x80 + (charCode & 0x3f)
      } else { // charCode is always < 0x10000 (it is a UTF-16 code unit).
        buf[bufIdx++] = 0xE0 + (charCode >>> 12)
        buf[bufIdx++] = 0x80 + ((charCode >>> 6) & 0x3f)
        buf[bufIdx++] = 0x80 + (charCode & 0x3f)
      }
    }
    return buf.subarray(0, bufIdx)
  }

  /** @returns {void} */
  end () {}
}

/**
 * CESU-8 decoder (UTR #26). Node has no native CESU-8 decoding (its "utf8" decoder correctly
 * rejects surrogate byte sequences as ill-formed UTF-8), so this is a hand-rolled state machine:
 * a lead byte selects the sequence length (1..3 bytes; 4-byte lead bytes are ill-formed in CESU-8),
 * continuation bytes accumulate the code unit, and each completed unit is emitted as-is (surrogate
 * pairs reassemble naturally in the UTF-16 output). Ill-formed input -- an aborted sequence, an
 * unexpected continuation byte, an overlong encoding or a 4-byte lead -- is replaced with the
 * bad-char (U+FFFD by default). Exception: the overlong NULL "C0 80" is accepted for Modified
 * UTF-8 (Java) compatibility. Streaming: the accumulator carries a sequence split across chunks.
 */
class Cesu8Decoder {
  /** @param {string} defaultCharUnicode Replacement for ill-formed input. */
  constructor (defaultCharUnicode) {
    this.acc = 0
    this.contBytes = 0
    this.accBytes = 0
    this.defaultCharUnicode = defaultCharUnicode
  }

  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string}
   */
  write (buf) {
    let acc = this.acc
    let contBytes = this.contBytes
    let accBytes = this.accBytes
    let res = ""
    for (let i = 0; i < buf.length; i++) {
      const curByte = buf[i]
      if ((curByte & 0xC0) !== 0x80) { // Lead byte.
        if (contBytes > 0) { // The previous sequence was aborted: ill-formed.
          res += this.defaultCharUnicode
          contBytes = 0
        }

        if (curByte < 0x80) { // Single-byte code unit.
          res += String.fromCharCode(curByte)
        } else if (curByte < 0xE0) { // Two-byte sequence.
          acc = curByte & 0x1F
          contBytes = 1; accBytes = 1
        } else if (curByte < 0xF0) { // Three-byte sequence.
          acc = curByte & 0x0F
          contBytes = 2; accBytes = 1
        } else { // Four or more bytes are ill-formed in CESU-8 (UTR #26 uses surrogate pairs instead).
          res += this.defaultCharUnicode
        }
      } else { // Continuation byte.
        if (contBytes > 0) { // We're waiting for it.
          acc = (acc << 6) | (curByte & 0x3f)
          contBytes--; accBytes++
          if (contBytes === 0) {
            // Reject overlong encodings, but accept Modified UTF-8's NULL as "C0 80".
            if (accBytes === 2 && acc < 0x80 && acc > 0) {
              res += this.defaultCharUnicode
            } else if (accBytes === 3 && acc < 0x800) {
              res += this.defaultCharUnicode
            } else {
              res += String.fromCharCode(acc)
            }
          }
        } else { // Unexpected continuation byte: ill-formed.
          res += this.defaultCharUnicode
        }
      }
    }
    this.acc = acc; this.contBytes = contBytes; this.accBytes = accBytes
    return res
  }

  /** @returns {string|number} The bad-char for a sequence left truncated at end of input. */
  end () {
    let res = 0
    if (this.contBytes > 0) { res += this.defaultCharUnicode }
    return res
  }
}

/**
 * Encoder for the stateless byte-string transports (binary, hex): each write() hands the textual
 * representation to Buffer.from, which parses it into bytes.
 */
class RawEncoder {
  /** @param {string} enc A Buffer encoding name. */
  constructor (enc) {
    this.enc = enc
  }

  /**
   * @param {string} str
   * @returns {Buffer}
   */
  write (str) {
    return Buffer.from(str, this.enc)
  }

  /** @returns {void} */
  end () {}
}

/**
 * Base64 encoder (base64 text -> bytes). Base64 works in 4-char quanta (RFC 4648, Section 4), so
 * only the complete quanta of each write() are parsed; the remainder (up to 3 chars) is carried
 * over, otherwise Buffer.from would mis-parse it as a truncated final quantum.
 */
class Base64Encoder {
  constructor () {
    this.prevStr = ""
  }

  /**
   * @param {string} str
   * @returns {Buffer}
   */
  write (str) {
    str = this.prevStr + str
    const completeQuads = str.length - (str.length % 4)
    this.prevStr = str.slice(completeQuads)
    str = str.slice(0, completeQuads)

    return Buffer.from(str, "base64")
  }

  /** @returns {Buffer} Bytes of the remaining (possibly padded or truncated) final quantum. */
  end () {
    return Buffer.from(this.prevStr, "base64")
  }
}

/**
 * Decoder for the byte-string transports (binary, base64, hex): bytes -> their textual
 * representation via buf.toString(enc). All input is buffered and serialized in one go at end(),
 * which keeps quantum alignment trivial (base64 must not emit padding mid-stream).
 */
class BufferedStringDecoder {
  /** @param {string} enc A Buffer encoding name. */
  constructor (enc) {
    this.enc = enc
    this.buffer = Buffer.from("")
  }

  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string} Always "": output is deferred to end().
   */
  write (buf) {
    if (!Buffer.isBuffer(buf)) {
      buf = Buffer.from(buf)
    }
    this.buffer = Buffer.concat([this.buffer, buf])
    return ""
  }

  /** @returns {string} The whole input, serialized. */
  end () {
    const res = this.buffer
    this.buffer = Buffer.from("")
    return res.toString(this.enc)
  }
}

exports.utf8 = Utf8Codec
// Alias UNICODE-1-1-UTF-8 (WHATWG maps it to UTF-8; pre-Unicode-2.0 UTF-8 differed only above BMP).
exports.unicode11utf8 = "utf8"

exports.cesu8 = Cesu8Codec

exports.binary = BinaryCodec
exports.base64 = Base64Codec
exports.hex = HexCodec
