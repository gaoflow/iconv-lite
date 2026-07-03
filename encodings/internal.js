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

/** Max args for one String.fromCharCode.apply() before risking a call-stack overflow. */
const CHARS_CHUNK = 8192
/** Above this many code units the native TextDecoder beats fromCharCode; below it the per-call setup costs more. */
const TEXT_DECODER_MIN_UNITS = 64
/**
 * Turns decoded UTF-16 code units (held in a Uint16Array, native little-endian) into a string in
 * one native call. Only used for runs with no surrogate (where it equals the verbatim conversion),
 * since it would otherwise replace a lone surrogate with U+FFFD instead of passing it through.
 * @type {TextDecoder}
 */
const utf16leDecoder = new TextDecoder("utf-16le", { ignoreBOM: true })

/**
 * Builds a string from the first `length` code units of a Uint16Array, in stack-safe chunks.
 * @param {Uint16Array} units
 * @param {number} length Number of valid code units in `units`.
 * @returns {string}
 */
function charsFromUnits (units, length) {
  let result = ""
  for (let offset = 0; offset < length; offset += CHARS_CHUNK) {
    result += String.fromCharCode.apply(null, units.subarray(offset, Math.min(offset + CHARS_CHUNK, length)))
  }
  return result
}

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
  createDecoder (options, iconv) { return new Cesu8Decoder(iconv.defaultCharUnicode, !!(options && options.fatal)) }
  get bomAware () { return true }
}

/**
 * Binary codec, an alias of Node's "binary"/"latin1" Buffer encoding: byte value <-> code point
 * (the ISO-8859-1 identity mapping, U+0000..U+00FF). This is intentionally NOT the WHATWG "latin1"
 * label, which resolves to windows-1252; that one is served by the sbcs tables.
 */
class BinaryCodec {
  createEncoder (options, iconv) { return new BinaryEncoder() }
  createDecoder (options, iconv) { return new BinaryDecoder() }
}

/**
 * Base64 codec (RFC 4648, Section 4), with Node Buffer's forgiving parser: non-alphabet bytes
 * (whitespace etc.) are ignored and an incomplete trailing quantum is truncated. Both directions
 * are streaming-safe: base64 maps 3 bytes <-> one 4-char quantum, so the encoder only feeds whole
 * quanta to the parser and the decoder only serializes whole 3-byte groups, carrying the remainder
 * over to the next write().
 */
class Base64Codec {
  createEncoder (options, iconv) { return new Base64Encoder() }
  createDecoder (options, iconv) { return new Base64Decoder() }
}

/**
 * Hex codec (RFC 4648, Section 8, "Base16"), matching Node Buffer's semantics: decoding emits
 * lowercase hex; encoding parses hex pairs and stops at the first invalid or incomplete pair. The
 * encoder is streaming-safe: a pair split across two write() calls is carried over, not dropped.
 */
class HexCodec {
  createEncoder (options, iconv) { return new HexEncoder() }
  createDecoder (options, iconv) { return new HexDecoder() }
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
    // allocUnsafe skips the zero-fill; every byte up to bufIdx is written below.
    const buf = Buffer.allocUnsafe(str.length * 3)
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
 * bad-char (U+FFFD by default), or throws with { fatal: true }. Exception: the overlong NULL
 * "C0 80" is accepted for Modified UTF-8 (Java) compatibility. Streaming: the accumulator carries
 * a sequence split across chunks.
 */
class Cesu8Decoder {
  /**
   * @param {string} defaultCharUnicode Replacement for ill-formed input.
   * @param {boolean} fatal Throw on ill-formed input instead of emitting the replacement.
   */
  constructor (defaultCharUnicode, fatal) {
    this.acc = 0
    this.contBytes = 0
    this.accBytes = 0
    this.defaultCharUnicode = defaultCharUnicode
    this.fatal = fatal
    this.units = new Uint16Array(0) // Decoded code units, reused across writes; grows lazily.
  }

  /**
   * Handles one ill-formed sequence: throws when fatal, otherwise appends the bad-char's code units.
   * @param {Uint16Array} units
   * @param {number} pos Current code-unit write position.
   * @returns {number} The new code-unit write position.
   */
  _replacement (units, pos) {
    if (this.fatal) { throw new Error("Ill-formed CESU-8 byte sequence") }
    const badChar = this.defaultCharUnicode
    for (let i = 0; i < badChar.length; i++) { units[pos++] = badChar.charCodeAt(i) }
    return pos
  }

  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string}
   */
  write (buf) {
    let acc = this.acc
    let contBytes = this.contBytes
    let accBytes = this.accBytes
    // Worst case is one unit per byte, or the bad-char per byte if it's longer than one unit.
    const maxUnits = buf.length * Math.max(1, this.defaultCharUnicode.length) + 1
    if (this.units.length < maxUnits) { this.units = new Uint16Array(maxUnits) }
    const units = this.units
    let pos = 0

    for (let i = 0; i < buf.length; i++) {
      const curByte = buf[i]
      if ((curByte & 0xC0) !== 0x80) { // Lead byte.
        if (contBytes > 0) { // The previous sequence was aborted: ill-formed.
          pos = this._replacement(units, pos)
          contBytes = 0
        }

        if (curByte < 0x80) { // Single-byte code unit.
          units[pos++] = curByte
        } else if (curByte < 0xE0) { // Two-byte sequence.
          acc = curByte & 0x1F
          contBytes = 1; accBytes = 1
        } else if (curByte < 0xF0) { // Three-byte sequence.
          acc = curByte & 0x0F
          contBytes = 2; accBytes = 1
        } else { // Four or more bytes are ill-formed in CESU-8 (UTR #26 uses surrogate pairs instead).
          pos = this._replacement(units, pos)
        }
      } else { // Continuation byte.
        if (contBytes > 0) { // We're waiting for it.
          acc = (acc << 6) | (curByte & 0x3f)
          contBytes--; accBytes++
          if (contBytes === 0) {
            // Reject overlong encodings, but accept Modified UTF-8's NULL as "C0 80".
            if (accBytes === 2 && acc < 0x80 && acc > 0) {
              pos = this._replacement(units, pos)
            } else if (accBytes === 3 && acc < 0x800) {
              pos = this._replacement(units, pos)
            } else {
              units[pos++] = acc
            }
          }
        } else { // Unexpected continuation byte: ill-formed.
          pos = this._replacement(units, pos)
        }
      }
    }
    this.acc = acc; this.contBytes = contBytes; this.accBytes = accBytes

    // Long surrogate-free output converts in one native call; a surrogate anywhere (a code unit
    // 0xD800..0xDFFF, the essence of CESU-8) must pass through verbatim, which TextDecoder won't
    // do for a lone one, so those fall back to the stack-safe fromCharCode path.
    if (pos >= TEXT_DECODER_MIN_UNITS) {
      let hasSurrogate = false
      for (let k = 0; k < pos; k++) {
        const unit = units[k]
        if (unit >= 0xD800 && unit <= 0xDFFF) { hasSurrogate = true; break }
      }
      if (!hasSurrogate) { return utf16leDecoder.decode(new Uint8Array(units.buffer, 0, pos * 2)) }
    }
    return charsFromUnits(units, pos)
  }

  /** @returns {string|undefined} The bad-char for a sequence left truncated at end of input (or throws when fatal). */
  end () {
    if (this.contBytes === 0) { return }
    this.contBytes = 0
    if (this.fatal) { throw new Error("Truncated CESU-8 sequence at end of input") }
    return this.defaultCharUnicode
  }
}

/**
 * Binary encoder (latin1 text -> bytes): each char becomes the byte `charCode & 0xFF` (Buffer's
 * "binary"/"latin1" behavior for code points above U+00FF). Stateless.
 */
class BinaryEncoder {
  /**
   * @param {string} str
   * @returns {Buffer}
   */
  write (str) {
    return Buffer.from(str, "binary")
  }

  /** @returns {void} */
  end () {}
}

/**
 * Binary decoder (bytes -> latin1 text): byte value -> code point, 1:1. Stateless, so each chunk
 * is serialized as it comes in.
 */
class BinaryDecoder {
  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string}
   */
  write (buf) {
    return asBuffer(buf).toString("binary")
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
 * Base64 decoder (bytes -> base64 text). Only whole 3-byte groups are serialized during write()
 * (they map to whole 4-char quanta, so no padding is emitted mid-stream and the concatenated
 * chunks equal the base64 of the whole input); the remainder (up to 2 bytes) is carried over, and
 * end() serializes it as the final, possibly padded, quantum.
 */
class Base64Decoder {
  constructor () {
    this.overflow = Buffer.alloc(3) // Bytes of an incomplete final group, finished by the next chunk.
    this.overflowLen = 0
  }

  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string}
   */
  write (buf) {
    if (this.overflowLen + buf.length < 3) {
      for (let i = 0; i < buf.length; i++) { this.overflow[this.overflowLen++] = buf[i] }
      return ""
    }

    let res = ""
    let pos = 0
    if (this.overflowLen > 0) {
      // Finish the group that was split across the previous chunk boundary.
      for (; this.overflowLen < 3; pos++) { this.overflow[this.overflowLen++] = buf[pos] }
      res = this.overflow.toString("base64")
      this.overflowLen = 0
    }

    const groupsEnd = pos + ((buf.length - pos) / 3 | 0) * 3
    if (groupsEnd > pos) { res += asBuffer(buf).subarray(pos, groupsEnd).toString("base64") }

    for (let i = groupsEnd; i < buf.length; i++) { this.overflow[this.overflowLen++] = buf[i] }
    return res
  }

  /** @returns {string|undefined} The final quantum, padded per RFC 4648, for 1..2 leftover bytes. */
  end () {
    if (this.overflowLen === 0) { return }
    const res = this.overflow.subarray(0, this.overflowLen).toString("base64")
    this.overflowLen = 0
    return res
  }
}

/**
 * Hex encoder (hex text -> bytes). A byte is a 2-digit pair (RFC 4648, Section 8), so an odd
 * trailing digit is carried over to the next write() instead of being fed to the parser, which
 * would drop it as an incomplete pair mid-stream.
 */
class HexEncoder {
  constructor () {
    this.prevChar = ""
  }

  /**
   * @param {string} str
   * @returns {Buffer}
   */
  write (str) {
    if (this.prevChar) {
      str = this.prevChar + str
      this.prevChar = ""
    }
    if (str.length % 2 !== 0) {
      this.prevChar = str[str.length - 1]
      str = str.slice(0, -1)
    }
    return Buffer.from(str, "hex")
  }

  /** @returns {void} A dangling lone digit is an incomplete pair, dropped like Buffer.from does. */
  end () {
    this.prevChar = ""
  }
}

/**
 * Hex decoder (bytes -> hex text): byte -> 2 lowercase digits. Stateless, so each chunk is
 * serialized as it comes in.
 */
class HexDecoder {
  /**
   * @param {Buffer|Uint8Array} buf
   * @returns {string}
   */
  write (buf) {
    return asBuffer(buf).toString("hex")
  }

  /** @returns {void} */
  end () {}
}

/**
 * Views a Uint8Array as a Buffer without copying, so Buffer.prototype serializers can be used on it.
 * @param {Buffer|Uint8Array} bytes
 * @returns {Buffer}
 */
function asBuffer (bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
}

exports.utf8 = Utf8Codec
// Alias UNICODE-1-1-UTF-8 (WHATWG maps it to UTF-8; pre-Unicode-2.0 UTF-8 differed only above BMP).
exports.unicode11utf8 = "utf8"

exports.cesu8 = Cesu8Codec

exports.binary = BinaryCodec
exports.base64 = Base64Codec
exports.hex = HexCodec
