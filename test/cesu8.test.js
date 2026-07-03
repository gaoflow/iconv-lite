"use strict"

const assert = require("assert")
const Buffer = require("buffer").Buffer
const iconv = require("../")

describe("CESU-8 codec", function () {
  it("encodes correctly", function () {
    assert.equal(iconv.encode("E", "cesu8").toString("hex"), "45")
    assert.equal(iconv.encode("¢", "cesu8").toString("hex"), "c2a2")
    assert.equal(iconv.encode("ȅ", "cesu8").toString("hex"), "c885")
    assert.equal(iconv.encode("€", "cesu8").toString("hex"), "e282ac")
    assert.equal(iconv.encode("𐐀", "cesu8").toString("hex"), "eda081edb080")
    assert.equal(iconv.encode("😱", "cesu8").toString("hex"), "eda0bdedb8b1")
    assert.equal(iconv.encode("a😱a", "cesu8").toString("hex"), "61eda0bdedb8b161")
    assert.equal(iconv.encode("😱😱", "cesu8").toString("hex"), "eda0bdedb8b1eda0bdedb8b1")
  })
  it("decodes correctly", function () {
    assert.equal(iconv.decode(Buffer.from("45", "hex"), "cesu8"), "E")
    assert.equal(iconv.decode(Buffer.from("c2a2", "hex"), "cesu8"), "¢")
    assert.equal(iconv.decode(Buffer.from("c885", "hex"), "cesu8"), "ȅ")
    assert.equal(iconv.decode(Buffer.from("e282ac", "hex"), "cesu8"), "€")
    assert.equal(iconv.decode(Buffer.from("eda081edb080", "hex"), "cesu8"), "𐐀")
    assert.equal(iconv.decode(Buffer.from("eda0bdedb8b1", "hex"), "cesu8"), "😱")
  })

  it("replaces ill-formed input with U+FFFD by default", function () {
    // Overlong 2-byte and 3-byte encodings.
    assert.equal(iconv.decode(Buffer.from("c1bf", "hex"), "cesu8"), "�")
    assert.equal(iconv.decode(Buffer.from("e08080", "hex"), "cesu8"), "�")
    // A 4-byte lead is ill-formed in CESU-8 (UTR #26 encodes supplementary chars as surrogate
    // pairs); its continuation bytes are then each unexpected.
    assert.equal(iconv.decode(Buffer.from("f09f98b1", "hex"), "cesu8"), "����")
    // Unexpected continuation byte.
    assert.equal(iconv.decode(Buffer.from("8041", "hex"), "cesu8"), "�A")
    // Aborted sequence followed by a new character.
    assert.equal(iconv.decode(Buffer.from("e28241", "hex"), "cesu8"), "�A")
  })

  it("accepts Modified UTF-8's NULL (C0 80)", function () {
    assert.equal(iconv.decode(Buffer.from("c080", "hex"), "cesu8"), "\u0000")
  })

  it("passes a lone surrogate half through", function () {
    assert.equal(iconv.decode(Buffer.from("eda0bd", "hex"), "cesu8"), "\ud83d")
  })

  it("replaces a sequence truncated at end of input", function () {
    assert.equal(iconv.decode(Buffer.from("e282", "hex"), "cesu8"), "�")
    assert.equal(iconv.decode(Buffer.from("41c2", "hex"), "cesu8"), "A�")
  })

  it("decodes sequences split across chunks", function () {
    const decoder = iconv.getDecoder("cesu8")
    const bytes = Buffer.from("61eda0bdedb8b162", "hex") // "a😱b"
    let res = ""
    for (let i = 0; i < bytes.length; i++) { res += decoder.write(bytes.subarray(i, i + 1)) }
    res += decoder.end() || ""
    assert.equal(res, "a😱b")
  })

  it("throws on ill-formed input in fatal mode", function () {
    assert.throws(function () { iconv.decode(Buffer.from("c1bf", "hex"), "cesu8", { fatal: true }) })
    assert.throws(function () { iconv.decode(Buffer.from("e282", "hex"), "cesu8", { fatal: true }) }) // Truncated at end.
    assert.equal(iconv.decode(Buffer.from("e282ac", "hex"), "cesu8", { fatal: true }), "€")
  })
})
