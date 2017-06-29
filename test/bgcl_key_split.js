// This is somewhat ad-hoc test for the key splitting function.
// The constants and mock classes probably are not useful for other tests.
const assert = require("assert");

const _ = require("lodash");

const { BGCL } = require("../src/bgcl");
const { BitGo } = require("bitgo");
const secrets = require("secrets.js");

const testKey = {
  seed: '0461171e40ce688818cea83fa0a126f7c468f81d7120c5cbb0aa60343c7c5183',
  xpub: 'xpub661MyMwAqRbcGRAn6C3ThGqBmV6WJddYfCXKS37CcKQo8P3fXgrJLyf54CpieD3RF5YdQbshSca2gy8y42nvJU4vhxVxeEHQwBBd6cwSEFC',
  xprv: 'xprv9s21ZrQH143K3w6JzAWTL8tTDTG1uAuhHybidehb3yspFaiWz9Y3oBLbCuLZUvZjUEeNpdKpMXXBqBe5vZHQhwPDfMuduJoKdAARrauKWCn'
}

class BGCLFixedKey extends BGCL {
  constructor(k) {
    super();
    this.fixedKey = k
    this.bitgo = new BitGo();
  }

  genKey() {
    return this.fixedKey;
  }
}

describe("BGCL", function () {
  it("splits keys that can be recombined", function () {
    let bgcl = new BGCLFixedKey(testKey);

    let params = {
      m: 2,
      n: 3,
      password0: 'test0',
      password1: 'test1',
      password2: 'test2'
    }

    let result = bgcl.genSplitKey(params);
    let decrypted = _.map(result.seedShares, (v, i) => {
      return bgcl.bitgo.decrypt({ password: 'test'+i, input: v });
    });

    // unfortunately we can't test a high-level bgcl method here
    // without mocking everything
    let seed = secrets.combine(decrypted);
    assert.equal(seed, testKey.seed);
  });
});
