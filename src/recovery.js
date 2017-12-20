const request = require('superagent');
require('superagent-as-promised')(request);
const fs = require('fs');
const Promise = require('bluebird');
const co = Promise.coroutine;
const _ = require('lodash');
const bitcoin = require('bitgo').bitcoin;

/**
 * An instance of the recovery tool, which encapsulates the recovery functions
 * Instantiated with parameters:
 *   - bitgo: an instance of the bitgo SDK
 *   - sourceCoin: the coin that needs to be recovered
 *   - recoveryType: the type of address the faulty transaction was sent to
 */
const CrossChainRecoveryTool = function CrossChainRecoveryTool(opts) {
  Object.assign(this, opts);

  if (!this.bitgo) {
    throw new Error('Please instantiate the recovery tool with a bitgo instance.');
  }

  // List of coins we support. Add modifiers (e.g. segwit) after the dash
  this.supportedCoins = ['btc', 'bch', 'btc-segwit'];

  if (!opts.sourceCoin || !this.supportedCoins.includes(opts.sourceCoin)) {
    throw new Error('Please set a valid source coin');
  }

  if (!opts.recoveryType || !this.supportedCoins.includes(opts.recoveryType)) {
    throw new Error('Please set a valid recovery type');
  }

  this._setCoinInstances(opts.sourceCoin, opts.recoveryType);
  this.wallets = { source: null, dest: null };
  this.addresses = { source: null, dest: null };

  this.feeRates = {
    bch: 20,
    tbch: 20,
    btc: 80,
    tbtc: 80
  };
};

/**
 * Internal function to set baseCoin instances for each coin specified in constructor
 * @param sourceCoin - the coin type the originated the transaction (also the coin to be recovered)
 * @param recoveryCoin - the coin type of the wallet the 'faulty address' belongs to
 * @private
 */
CrossChainRecoveryTool.prototype._setCoinInstances = function _setCoinInstances(source, recovery) {
  /* eslint-disable no-unused-vars */
  const [sourceCoin, sourceModifier] = source.split('-');
  const [recoveryCoin, recoveryModifier] = recovery.split('-');
  /* eslint-enable no-unused-vars */

  // Leaving modifiers alone for now. In the future we can use this to do SegWit recoveries

  let network;

  if (this.test) {
    this.sourceCoin = this.bitgo.coin('t' + sourceCoin);
    this.recoveryCoin = this.bitgo.coin('t' + recoveryCoin);

    network = bitcoin.networks.testnet;
  } else {
    this.sourceCoin = this.bitgo.coin(sourceCoin);
    this.recoveryCoin = this.bitgo.coin(recoveryCoin);

    network = bitcoin.networks.bitcoin;
  }

  this.recoveryTx = new bitcoin.TransactionBuilder(network);

  if (sourceCoin === 'bch') {
    this.recoveryTx.enableBitcoinCash(true);
    this.recoveryTx.setVersion(2);
  }
};

/**
 * Internal logging function (either uses provided logger or console.log, can be turned off)
 * @param args - the arguments to pass to the logger
 * @private
 */
CrossChainRecoveryTool.prototype._log = function _log(...args) {
  if (this.logging === false) {
    return;
  }

  this.logger ? this.logger(...args) : console.log(...args);
};


CrossChainRecoveryTool.prototype.setWallet = function setWallet(coinType, walletId) {
  return co(function *() {
    if (!coinType) {
      throw new Error('Please provide coin type');
    }

    if (!walletId) {
      throw new Error('Please provide wallet id');
    }

    this._log(`Fetching ${coinType} wallet...`);

    if (this.sourceCoin.type !== coinType && this.recoveryCoin.type !== coinType) {
      throw new Error('Cannot set a wallet for this coin type - this is not a coin involved in the recovery tx.');
    }

    let wallet;
    try {
      wallet = yield this.bitgo.coin(coinType).wallets().get({ id: walletId });
    } catch (e) {
      if (e.status !== 404 && e.status !== 400) {
        throw e;
      }

      wallet = null;
    }

    if (!wallet && coinType.endsWith('btc')) {
      try {
        this._log('Could not find v2 wallet. Falling back to v1...');
        wallet = yield this.bitgo.wallets().get({ id: walletId });
        wallet.isV1 = true;
      } catch (e) {
        if (e.status !== 404) {
          throw e;
        }
      }
    }

    if (!wallet) {
      throw new Error(`Cannot find ${coinType} wallet.`);
    }

    if (this.sourceCoin.type === coinType) {
      this.wallets.source = wallet;
      const res = yield wallet.addresses({});
      this.addresses.source = res.addresses;
    }

    if (this.recoveryCoin.type === coinType) {
      this.wallets.dest = wallet;
      const res = yield wallet.addresses({});
      this.addresses.dest = res.addresses;
    }
  }).call(this);
};

CrossChainRecoveryTool.prototype.findUnspents = function findUnspents(faultyTxId) {
  return co(function *() {
    if (!faultyTxId) {
      throw new Error('Please provide a faultyTxId');
    }

    this._log('Grabbing info for faulty tx...');

    this.faultyTxId = faultyTxId;
    const TX_INFO_URL = this.sourceCoin.url(`/public/tx/${faultyTxId}`);
    const res = yield request.get(TX_INFO_URL);
    const faultyTxInfo = res.body;

    this._log('Getting unspents on output addresses..');

    // Get output addresses that do not belong to wallet
    // These are where the 'lost coins' live
    const outputAddresses = faultyTxInfo.outputs
    .map((input) => input.address)
    .filter((address) => _.find(this.addresses.dest, { address }));

    // Get unspents for addresses
    const ADDRESS_UNSPENTS_URL = this.sourceCoin.url(`/public/addressUnspents/${outputAddresses.join(',')}`);
    const addressRes = yield request.get(ADDRESS_UNSPENTS_URL);
    const unspents = addressRes.body;

    this.unspents = unspents;
    return unspents;
  }).call(this);
};

CrossChainRecoveryTool.prototype.buildInputs = function buildInputs(unspents) {
  this._log('Building inputs for recovery transaction...');

  unspents = unspents || this.unspents;

  if (!unspents) {
    throw new Error('Could not find unspents. Either supply an argument or call findUnspents');
  }

  const txInfo = {
    inputAmount: 0,
    outputAmount: 0,
    spendAmount: 0,
    inputs: [],
    outputs: [],
    externalOutputs: [],
    changeOutputs: [],
    minerFee: 0,
    payGoFee: 0
  };

  let totalFound = 0;
  const noSegwit = this.recoveryCoin.type === 'btc' && this.sourceCoin.type === 'bch';
  for (const unspent of unspents) {
    if (unspent.witnessScript && noSegwit) {
      throw new Error('Warning! It appears one of the unspents is on a Segwit address. The tool only recovers BCH from non-Segwit BTC addresses. Aborting.');
    }

    const unspentAddress = this.addresses.dest.find((address) => address.address === unspent.address);

    // This sometimes happens when a wallet has a lot of receive addresses
    if (!unspentAddress) {
      return;
    }

    this._log(`Found ${unspent.value * 1e-8} ${this.sourceCoin.type} at address ${unspent.address}`);

    const [txHash, index] = unspent.id.split(':');
    const inputIndex = parseInt(index, 10);
    let hash = new Buffer(txHash, 'hex');
    hash = new Buffer(Array.prototype.reverse.call(hash));

    try {
      this.recoveryTx.addInput(hash, inputIndex);
    } catch (e) {
      throw new Error(`Error adding unspent ${unspent.id}`);
    }

    let inputData = {};

    // Add v1 specific input fields
    if (this.wallets.dest.isV1) {
      unspentAddress.path = `/${unspentAddress.chain}/${unspentAddress.index}`;

      inputData = {
        redeemScript: unspentAddress.coinSpecific.redeemScript,
        witnessScript: unspentAddress.coinSpecific.witnessScript,
        path: '/0/0' + unspentAddress.path,
        chainPath: unspentAddress.path,
        txHash: unspent.tx,
        txOutputN: unspent.nOut,
        txValue: unspent.value,
        value: parseInt(unspent.value, 10)
      };
    } else {
      inputData = {
        redeemScript: unspentAddress.coinSpecific.redeemScript,
        witnessScript: unspentAddress.coinSpecific.witnessScript,
        index: unspentAddress.index,
        chain: unspentAddress.chain,
        wallet: this.wallets.dest.id(),
        fromWallet: this.wallets.dest.id()
      };
    }

    txInfo.inputs.push(Object.assign({}, unspent, inputData));

    txInfo.inputAmount += parseInt(unspent.value, 10);
    totalFound += parseInt(unspent.value, 10);
  }

  txInfo.unspents = _.clone(txInfo.inputs);

  // Normalize total found to base unit before we print it out
  this._log(`Found lost ${totalFound * 1e-8} ${this.sourceCoin.type}.`);

  this.txInfo = txInfo;
  return txInfo;
};

CrossChainRecoveryTool.prototype.setFees = function setFees(recoveryTx) {
  recoveryTx = recoveryTx || this.recoveryTx;

  // Determine fee with default fee rate
  const P2SH_INPUT_SIZE = 295;
  const OUTPUT_SIZE = 34;
  const TX_OVERHEAD_SIZE = 10;
  const feeRate = this.feeRates[this.sourceCoin.type];

  // Note that we assume one output here (all funds should be recovered to a single address)
  const txSize = P2SH_INPUT_SIZE * recoveryTx.tx.ins.length + OUTPUT_SIZE + TX_OVERHEAD_SIZE;
  const recoveryFee = feeRate * txSize;
  this.txInfo.minerFee = recoveryFee;

  return recoveryFee;
};

CrossChainRecoveryTool.prototype.buildOutputs = function buildOutputs(recoveryAddress, outputAmount, recoveryFee) {
  if (!outputAmount && !this.txInfo) {
    throw new Error('Could not find transaction info. Please provide an output amount, or call buildInputs.');
  }

  this._log(`Building outputs for recovery transaction. Funds will be sent to ${recoveryAddress}...`);

  outputAmount = outputAmount || this.txInfo.inputAmount - (recoveryFee || this.txInfo.minerFee);
  this.txInfo.outputAmount = outputAmount;
  this.txInfo.spendAmount = outputAmount;


  if (outputAmount <= 0) {
    throw new Error('This recovery transaction cannot pay its own fees. Aborting.');
  }

  this.recoveryTx.addOutput(recoveryAddress, outputAmount);

  const outputData = {
    address: recoveryAddress,
    value: outputAmount,
    valueString: outputAmount.toString(),
    wallet: this.wallets.source.id(),
    change: false
  };

  this.txInfo.outputs.push(outputData);
  this.txInfo.externalOutputs.push(outputData);
};

CrossChainRecoveryTool.prototype.signTransaction = function signTransaction({ prv, passphrase, keychain }) {
  return co(function *() {
    if (!this.txInfo) {
      throw new Error('Could not find txInfo. Please build a transaction');
    }

    this._log('Signing the transaction...');

    const transactionHex = this.recoveryTx.buildIncomplete().toHex();

    if (!prv) {
      const keys = yield this.getKeys(passphrase);
      prv = keys.prv;
    }

    const txPrebuild = { txHex: transactionHex, txInfo: this.txInfo };
    this.halfSignedRecoveryTx = this.sourceCoin.signTransaction({ txPrebuild, prv });

    return this.halfSignedRecoveryTx;
  }).call(this);
};

CrossChainRecoveryTool.prototype.getKeys = function getPrv(passphrase) {
  return co(function *() {
    let prv;

    let keychain;
    try {
      keychain = yield this.wallets.dest.getEncryptedUserKeychain();
    } catch (e) {
      if (e.status !== 404) {
        throw e;
      }
    }

    if (!passphrase) {
      throw new Error('You have an encrypted user keychain - please provide the passphrase to decrypt it');
    }

    if (this.wallets.dest.isV1) {
      if (!keychain) {
        throw new Error('V1 wallets need a user keychain - could not find the proper keychain. Aborting');
      }
    }

    if (keychain) {
      try {
        prv = this.bitgo.decrypt({ input: keychain.encryptedPrv, password: passphrase });
      } catch (e) {
        throw new Error('Error reading private key. Please check that you have the correct wallet passphrase');
      }
    }

    if (this.wallets.dest.isV1) {
      keychain.xprv = prv;

      if (!keychain.path) {
        keychain.path = '';
      }

      return { keychain };
    } else {
      return { prv };
    }
  }).call(this);
};

CrossChainRecoveryTool.prototype.saveToFile = function saveToFile(fileName) {
  fileName = fileName || `${this.sourceCoin.type}r-${this.faultyTxId.slice(0, 6)}.signed.json`;

  const fileData = {
    version: this.wallets.dest.isV1 ? 1 : 2,
    walletId: this.wallets.dest.id(),
    txHex: this.halfSignedRecoveryTx.txHex || this.halfSignedRecoveryTx.tx,
    txInfo: this.txInfo
  };

  fs.writeFileSync(fileName, JSON.stringify(fileData, null, 4));

  this._log(`Saved recovery transaction info to ./${fileName}`);

  return fileName;
};

CrossChainRecoveryTool.prototype.buildTransaction = function buildTransaction({ sourceWallet, recoveryWallet, faultyTxId, recoveryAddress }) {
  return co(function *() {
    yield this.setWallet(this.sourceCoin.type, sourceWallet);
    yield this.setWallet(this.recoveryCoin.type, recoveryWallet);

    yield this.findUnspents(faultyTxId);
    this.buildInputs();
    this.setFees();
    this.buildOutputs(recoveryAddress);

    return this.recoveryTx;
  }).call(this);
};

module.exports = CrossChainRecoveryTool;
