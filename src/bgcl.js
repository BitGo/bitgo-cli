#!/usr/bin/env node

const ArgumentParser = require('argparse').ArgumentParser;
const bitgo = require('bitgo');
const bitcoin = bitgo.bitcoin;

const bs58check = require('bs58check');
const crypto = require('crypto');
const Q = require('q');
const Promise = require('bluebird');
const co = Promise.coroutine;
const fs = require('fs');
const moment = require('moment');
const read = require('read');
const readline = require('readline');
const secrets = require('secrets.js-grempe');
const sjcl = require('sjcl');
const qr = require('qr-image');
const open = require('open');
const util = require('util');
const _ = require('lodash');
_.string = require('underscore.string');
const pjson = require('../package.json');
const CLI_VERSION = pjson.version;

const request = require('superagent');
require('superagent-as-promised')(request);

const RecoveryTool = require('./recovery');

// Enable for better debugging
// Q.longStackSupport = true;

const permsToRole = {};
permsToRole['admin,spend,view'] = 'admin';
permsToRole['spend,view'] = 'spender';
permsToRole['view'] = 'viewer';

function getUserHome() {
  return process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
}

const BITGO_DIR = getUserHome() + '/.bitgo';

function jsonFilename(name) {
  return BITGO_DIR + '/' + name + '.json';
}

function loadJSON(name) {
  try {
    const data = fs.readFileSync(jsonFilename(name), { encoding: 'utf8' });
    return JSON.parse(data);
  } catch (e) {
    return undefined;
  }
}

function saveJSON(name, data) {
  if (!fs.existsSync(BITGO_DIR)) {
    fs.mkdirSync(BITGO_DIR, 0700);
  }
  data = JSON.stringify(data, null, 2);
  fs.writeFileSync(jsonFilename(name), data, { encoding: 'utf8', mode: 0600 });
}

const UserInput = function(args) {
  _.assign(this, args);
};

// Prompt the user for input
UserInput.prototype.prompt = function(question, required) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const deferred = Q.defer();
  rl.setPrompt(question);
  rl.prompt();
  rl.on('line', function(line) {
    line = line.trim();
    if (line || !required) {
      deferred.resolve(line);
      rl.close();
    } else {
      rl.prompt();
    }
  });
  return deferred.promise;
};

// Prompt the user for password input
UserInput.prototype.promptPassword = function(question, allowBlank) {
  const self = this;
  const internalPromptPassword = function() {
    const deferred = Q.defer();
    read({ prompt: question, silent: true, replace: '*' }, function(err, result) {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve(result);
      }
    });
    return deferred.promise;
  };

  // Ensure password not blank
  return internalPromptPassword()
  .then(function(password) {
    if (password || allowBlank) {
      return password;
    }
    return self.promptPassword(question);
  });
};

// Get input from user into variable, with question as prompt
UserInput.prototype.getVariable = function(name, question, required, defaultValue) {
  const self = this;
  return function() {
    return Q().then(function() {
      if (self[name]) {
        return;
      }
      return Q().then(function() {
        if (name === 'password' || name === 'passcode') {
          return self.promptPassword(question);
        } else {
          return self.prompt(question, required);
        }
      })
      .then(function(value) {
        if (!value && defaultValue) {
          value = defaultValue;
        }
        self[name] = value;
      });
    });
  };
};

UserInput.prototype.getPassword = function(name, question, confirm) {
  const self = this;
  let password;

  return function() {
    return Q().then(function() {
      if (self[name]) {
        return;
      }
      return self.promptPassword(question)
      .then(function(value) {
        password = value;
        if (confirm) {
          return self.promptPassword('Confirm ' + question, true);
        }
      })
      .then(function(confirmation) {
        if (confirm && confirmation !== password) {
          console.log("passwords don't match -- try again");
          return self.getPassword(name, question, confirm)();
        } else {
          self[name] = password;
        }
      });
    });
  };
};


UserInput.prototype.getIntVariable = function(name, question, required, min, max) {
  const self = this;
  return function() {
    return self.getVariable(name, question, required)()
    .then(function() {
      const value = parseInt(self[name], 10);
      // eslint-disable-next-line
      if (value != self[name]) {
        throw new Error('integer value required');
      }
      if (value < min) {
        throw new Error('value must be at least ' + min);
      }
      if (value > max) {
        throw new Error('value must be at most ' + max);
      }
      self[name] = value;
    })
    .catch(function(err) {
      console.log(err.message);
      delete self[name];
      if (required) {
        return self.getIntVariable(name, question, required, min, max)();
      }
    });
  };
};

const Shell = function(bgcl) {
  this.bgcl = bgcl;
};

Shell.prototype.prompt = function() {
  const bgcl = this.bgcl;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const deferred = Q.defer();
  let prompt = '[bitgo';
  if (bgcl.session && bgcl.session.wallet) {
    prompt = prompt + ' @ ' + bgcl.session.wallet.label();
  }
  prompt = prompt + ']\u0243 ';
  rl.setPrompt(prompt);
  rl.on('line', function(line) {
    line = line.trim();
    if (line) {
      deferred.resolve(line);
      rl.close();
    } else {
      rl.prompt();
    }
  });
  rl.prompt();
  return deferred.promise;
};

const Session = function(bitgo) {
  this.bitgo = bitgo;
  this.wallet = undefined;
  this.wallets = {};
  this.labels = {};
};

Session.prototype.load = function() {
  const session = loadJSON(this.bitgo.getEnv());
  if (session) {
    if (session.bitgo) {
      this.bitgo.fromJSON(session.bitgo);
    }
    if (session.wallet) {
      this.wallet = this.bitgo.newWalletObject(session.wallet);
    }
    this.wallets = session.wallets;
    this.labels = session.labels;
  }
};

Session.prototype.toJSON = function() {
  return {
    bitgo: this.bitgo,
    wallet: this.wallet,
    wallets: this.wallets,
    labels: this.labels
  };
};

Session.prototype.save = function() {
  saveJSON(this.bitgo.getEnv(), this);
};

Session.prototype.labelForWallet = function(walletId) {
  return this.wallets && this.wallets[walletId] && this.wallets[walletId].label;
};

Session.prototype.labelForAddress = function(address) {
  const wallet = this.wallet;
  const labels = this.labels && this.labels[address];
  if (!labels || labels.length === 0) {
    return undefined;
  }
  if (labels.length === 1) {
    return labels[0].label;
  }
  let foundLabel;
  labels.forEach(function(label) {
    if (label.walletId === wallet.id()) {
      foundLabel = label.label;
      return false; // break out
    }
  });
  if (foundLabel) { return foundLabel; }
  return labels[0].label; // found multiple, return first one
};

const BGCL = function() {
};

BGCL.prototype.createArgumentParser = function() {
  /* eslint-disable no-unused-vars */
  const parser = new ArgumentParser({
    version: CLI_VERSION,
    addHelp: true,
    description: 'BitGo Command-Line'
  });
  parser.addArgument(
    ['-e', '--env'], {
      help: 'BitGo environment to use: prod (default) or test. Can also be set with the BITGO_ENV environment variable.'
    }
  );
  parser.addArgument(['-j', '--json'], { action: 'storeTrue', help: 'output JSON (if available)' });

  const subparsers = parser.addSubparsers({
    title: 'subcommands',
    dest: 'cmd'
  });
  this.subparsers = subparsers;

  // login
  const login = subparsers.addParser('login', {
    addHelp: true,
    help: 'Sign in to BitGo'
  });
  login.addArgument(['-u', '--username'], { help: 'the account email' });
  login.addArgument(['-p', '--password'], { help: 'the account password' });
  login.addArgument(['-o', '--otp'], { help: 'the 2-step verification code' });

  // logout
  const logout = subparsers.addParser('logout', {
    addHelp: true,
    help: 'Sign out of BitGo'
  });

  // token
  const token = subparsers.addParser('token', {
    addHelp: true,
    help: 'Get or set the current auth token'
  });
  token.addArgument(['token'], { nargs: '?', help: 'the token to set' });

  // status
  const status = subparsers.addParser('status', {
    addHelp: true,
    help: 'Show current status'
  });

  /**
   * OTP Commands
   */
  const otp = subparsers.addParser('otp', { help: 'OTP commands (use otp -h to see commands)' });
  const otpCommands = otp.addSubparsers({
    title: 'otp commands',
    dest: 'cmd2'
  });

  // otp list
  const otpList = otpCommands.addParser('list', { help: 'List OTP methods' });

  // otp remove
  const otpRemove = otpCommands.addParser('remove', { help: 'Remove OTP device' });
  otpRemove.addArgument(['deviceId'], { help: 'the device id to remove' });

  // otp add
  const otpAdd = otpCommands.addParser('add', { help: 'Add an OTP device' });
  otpAdd.addArgument(['type'], { choices: ['totp', 'yubikey', 'authy'], help: 'Type of device to add' });

  // wallets
  const wallets = subparsers.addParser('wallets', {
    addHelp: true,
    help: 'Get list of available wallets'
  });

  // wallet
  const wallet = subparsers.addParser('wallet', {
    addHelp: true,
    help: 'Set or get the current wallet'
  });
  wallet.addArgument(['wallet'], { nargs: '?', help: 'the index, id, or name of the wallet to set as current' });

  // balance
  const balance = subparsers.addParser('balance', {
    addHelp: true,
    help: 'Get current wallet balance'
  });
  balance.addArgument(['-c', '--confirmed'], { action: 'storeTrue', help: 'Exclude unconfirmed transactions' });
  balance.addArgument(['-u', '--unit'], { help: 'select units: satoshi | bits | btc [default]' });

  // labels
  const labels = subparsers.addParser('labels', {
    addHelp: true,
    help: 'Show labels'
  });
  labels.addArgument(['-a', '--all'], {
    help: 'show labels on all wallets, not just current',
    nargs: 0,
    action: 'storeTrue'
  });

  // setlabel
  const setLabel = subparsers.addParser('setlabel', {
    addHelp: true,
    help: 'Set a label on any address (in curr. wallet context)'
  });
  setLabel.addArgument(['address'], { help: 'the address to label' });
  setLabel.addArgument(['label'], { help: 'the label' });

  // removelabel
  const removeLabel = subparsers.addParser('removelabel', {
    addHelp: true,
    help: 'Remove a label on an address (in curr. wallet context)'
  });
  removeLabel.addArgument(['address'], { help: 'the address from which to remove the label' });

  // addresses
  const addresses = subparsers.addParser('addresses', {
    addHelp: true,
    help: 'List addresses for the current wallet'
  });
  addresses.addArgument(['-c', '--change'], { action: 'storeTrue', help: 'include change addresses' });

  // newaddress
  const newAddress = subparsers.addParser('newaddress', {
    addHelp: true,
    help: 'Create a new receive address for the current wallet'
  });
  newAddress.addArgument(['-c', '--change'], { action: 'storeTrue', help: 'create a change address' });
  newAddress.addArgument(['-l', '--label'], { help: 'optional label' });

  // unspents
  const unspents = subparsers.addParser('unspents', {
    aliases: ['unspent'],
    addHelp: true,
    help: 'Show unspents in the wallet'
  });
  unspents.addArgument(['-c', '--minconf'], { help: 'show only unspents with at least MINCONF confirms' });

  // unspents consolidation
  const consolidateUnspents = subparsers.addParser('consolidate', {
    addHelp: true,
    help: 'Consolidate unspents in a wallet'
  });
  consolidateUnspents.addArgument(['-t', '--target'], { type: 'int', help: 'consolidate unspents until only TARGET number of unspents is left (defaults to 1)' });
  consolidateUnspents.addArgument(['-i', '--inputCount'], { type: 'int', help: 'use up to that many inputs in a consolidation batch (defaults to 85)' });
  consolidateUnspents.addArgument(['-f', '--feeRate'], { type: 'int', help: 'set fee rate in satoshis per KB' });
  consolidateUnspents.addArgument(['-c', '--confirmTarget'], { type: 'int', help: 'set fee based on estimates for getting confirmed within this number of blocks' });
  consolidateUnspents.addArgument(['-m', '--maxSize'], { help: 'maximum size unspent in BTC to consolidate' });
  consolidateUnspents.addArgument(['-s', '--minSize'], { type: 'int', help: 'minimum size unspent in satoshis to consolidate' });
  consolidateUnspents.addArgument(['-x', '--xprv'], { type: 'string', help: 'private key (use if not storing the encrypted private key with BitGo' });
  consolidateUnspents.addArgument(['-a', '--minConfirms'], { type: 'int', help: 'only select unspents with at least this many confirmations' });
  consolidateUnspents.addArgument(['-b', '--maxIterationCount'], { type: 'int', help: 'Maximum number of consolidation iterations to perform.' });

  // unspents fanout
  const fanoutUnspents = subparsers.addParser('fanout', {
    addHelp: true,
    help: 'Fan out unspents in a wallet'
  });
  fanoutUnspents.addArgument(['-t', '--target'], { type: 'int', required: true, help: 'fan out up to TARGET number of unspents' });
  fanoutUnspents.addArgument(['-x', '--xprv'], { type: 'string', help: 'private key (use if not storing the encrypted private key with BitGo' });
  fanoutUnspents.addArgument(['-m', '--minConfirms'], { type: 'int', help: 'only select unspents with at least this many confirmations' });

  // txlist
  const txList = subparsers.addParser('tx', {
    addHelp: true,
    help: 'List transactions on the current wallet'
  });
  txList.addArgument(['-n'], { help: 'number of transactions to show' });

  // unlock
  const unlock = subparsers.addParser('unlock', {
    addHelp: true,
    help: 'Unlock the session to allow transacting'
  });
  unlock.addArgument(['otp'], { nargs: '?', help: 'the 2-step verification code' });

  // lock
  const lock = subparsers.addParser('lock', {
    addHelp: true,
    help: 'Re-lock the session'
  });

  // sendtoaddress
  const sendToAddress = subparsers.addParser('sendtoaddress', {
    addHelp: true,
    help: 'Create and send a transaction'
  });
  sendToAddress.addArgument(['-d', '--dest'], { help: 'the destination address' });
  sendToAddress.addArgument(['-a', '--amount'], { help: 'the amount in BTC' });
  sendToAddress.addArgument(['-p', '--password'], { help: 'the wallet password' });
  sendToAddress.addArgument(['-o', '--otp'], { help: 'the 2-step verification code' });
  sendToAddress.addArgument(['-c', '--comment'], { help: 'optional private comment' });
  sendToAddress.addArgument(['-u', '--unconfirmed'], { nargs: 0, help: 'allow spending unconfirmed external inputs' });
  sendToAddress.addArgument(['--confirm'], { action: 'storeConst', constant: 'go', help: 'skip interactive confirm step -- be careful!' });

  // freezewallet
  const freezeWallet = subparsers.addParser('freezewallet', {
    addHelp: true,
    help: 'Freeze (time-lock) the current wallet'
  });
  freezeWallet.addArgument(['-d', '--duration'], { help: 'the duration in seconds for which to freeze the wallet' });

  // removewallet
  const removeWallet = subparsers.addParser('removewallet', {
    addHelp: true,
    help: 'Remove a wallet from your account'
  });
  removeWallet.addArgument(['wallet'], { nargs: '?', help: 'the wallet ID of the wallet (default: current)' });

  // sharewallet
  const shareWallet = subparsers.addParser('sharewallet', {
    // addHelp: true,
    // help: 'Share the current wallet with another user'
  });
  shareWallet.addArgument(['-e', '--email'], { help: "email address of the recipient's BitGo account" });
  shareWallet.addArgument(['-r', '--role'], {
    help: 'role for the recipient on this wallet',
    choices: ['admin', 'spender', 'viewer']
  });
  shareWallet.addArgument(['-p', '--password'], { help: 'the wallet password' });
  shareWallet.addArgument(['-o', '--otp'], { help: 'the 2-step verification code' });
  shareWallet.addArgument(['-c', '--comment'], { help: 'a message for the recipient' });
  shareWallet.addArgument(['wallet'], { nargs: '?', help: 'the wallet id to share (default: current)' });

  // shares
  const shares = subparsers.addParser('shares', {
    // addHelp: true,
    // help: 'List outstanding wallet shares (incoming and outgoing)'
  });

  // acceptshare
  const acceptShare = subparsers.addParser('acceptshare', {
    // addHelp: true,
    // help: 'Accept a wallet share invite'
  });
  acceptShare.addArgument(['share'], { help: 'the share id' });

  // cancelshare
  const cancelShare = subparsers.addParser('cancelshare', {
    // addHelp: true,
    // help: 'Cancel or decline a wallet share invite'
  });
  cancelShare.addArgument(['share'], { help: 'the share id' });

  // newkey
  const newKey = subparsers.addParser('newkey', {
    addHelp: true,
    help: 'Create a new BIP32 keychain (client-side only)'
  });
  newKey.addArgument(['entropy'], { nargs: '?', help: 'optional additional entropy' });

  // encryptkey
  const encryptKey = subparsers.addParser('encryptkey', {
    addHelp: true,
    help: 'Encrypt a BIP32 private key with a password (client-side only)'
  });
  encryptKey.addArgument(['-x', '--xprv'], { help: 'xprv to encrypt' });
  encryptKey.addArgument(['-pa', '--password'], { help: 'password to encrypt key with' });
  encryptKey.addArgument(['-p', '--prefix'], { help: 'output file prefix' });

  // newwallet
  const newWallet = subparsers.addParser('newwallet', {
    addHelp: true,
    help: 'Create a new Multi-Sig HD wallet'
  });
  newWallet.addArgument(['-n', '--name'], { help: 'name for the wallet' });
  newWallet.addArgument(['-u', '--userkey'], { help: 'xprv for the user keychain' });
  newWallet.addArgument(['-b', '--backupkey'], { help: 'xpub for the backup keychain' });

  const splitKeys = subparsers.addParser('splitkeys', {
    addHelp: true,
    help: 'Create set of BIP32 keys, split into encrypted shares.'
  });
  splitKeys.addArgument(['-m'], { help: 'number of shares required to reconstruct a key' });
  splitKeys.addArgument(['-n'], { help: 'total number of shares per key' });
  splitKeys.addArgument(['-N', '--nkeys'], { help: 'total number of keys to generate' });
  splitKeys.addArgument(['-p', '--prefix'], { help: 'output file prefix' });
  splitKeys.addArgument(['-e', '--entropy'], { help: 'additional user-supplied entropy' });

  const verifySplitKeys = subparsers.addParser('verifysplitkeys', {
    addHelp: true,
    help: "Verify xpubs from an output file of 'splitkeys' (does not show xprvs)"
  });
  verifySplitKeys.addArgument(['-f', '--file'], { help: 'the input file (JSON format)' });
  verifySplitKeys.addArgument(['-k', '--keys'], { help: 'comma-separated list of key indices to recover' });

  const recoverKeys = subparsers.addParser('recoverkeys', {
    addHelp: true,
    help: "Recover key(s) from an output file of 'splitkeys' (xprvs are shown)"
  });
  recoverKeys.addArgument(['-v', '--verifyonly'], { action: 'storeConst', constant: 'true', help: 'verify only (do not show xprvs)' });
  recoverKeys.addArgument(['-f', '--file'], { help: 'the input file (JSON format)' });
  recoverKeys.addArgument(['-k', '--keys'], { help: 'comma-separated list of key indices to recover' });

  const dumpWalletUserKey = subparsers.addParser('dumpwalletuserkey', {
    addHelp: true,
    help: "Dumps the user's private key (first key in the 3 multi-sig keys) to the output"
  });
  dumpWalletUserKey.addArgument(['-p', '--password'], { help: 'the wallet password' });
  dumpWalletUserKey.addArgument(['--confirm'], { action: 'storeConst', constant: 'go', help: 'skip interactive confirm step -- be careful!' });

  const createTx = subparsers.addParser('createtx', {
    addHelp: true,
    help: 'Create an unsigned transaction (online) for signing (the signing can be done offline)'
  });
  createTx.addArgument(['-d', '--dest'], { help: 'the destination address' });
  createTx.addArgument(['-a', '--amount'], { help: 'the amount in BTC' });
  createTx.addArgument(['-f', '--fee'], { help: 'fee to pay for transaction' });
  createTx.addArgument(['-c', '--comment'], { help: 'optional private comment' });
  createTx.addArgument(['-p', '--prefix'], { help: 'output file prefix' });
  createTx.addArgument(['-u', '--unconfirmed'], { nargs: 0, help: 'allow spending unconfirmed external inputs' });

  const signTx = subparsers.addParser('signtx', {
    addHelp: true,
    help: 'Sign a transaction (can be used offline) with an input transaction JSON file'
  });
  signTx.addArgument(['-f', '--file'], { help: 'the input transaction file (JSON format)' });
  signTx.addArgument(['--confirm'], { action: 'storeConst', constant: 'go', help: 'skip interactive confirm step -- be careful!' });
  signTx.addArgument(['-k', '--key'], { help: 'xprv (private key) for signing' });
  signTx.addArgument(['-p', '--prefix'], { nargs: '?', help: 'optional output file prefix' });

  const sendTransaction = subparsers.addParser('sendtx', {
    addHelp: true,
    help: 'Send a transaction for co-signing to BitGo'
  });
  sendTransaction.addArgument(['-t', '--txhex'], { help: 'the transaction hex to send' });
  sendTransaction.addArgument(['-f', '--file'], { nargs: '?', help: 'optional input file containing the tx hex' });

  // shell
  const shell = subparsers.addParser('shell', {
    addHelp: true,
    help: 'Run the BitGo command shell'
  });

  // listWebhooks
  const listWebhooks = subparsers.addParser('listWebhooks', {
    addHelp: true,
    help: 'Show webhooks for the current wallet'
  });

  // addWebhook
  const addWebhook = subparsers.addParser('addWebhook', {
    addHelp: true,
    help: 'Add a webhook for the current wallet'
  });
  addWebhook.addArgument(['-u', '--url'], { help: 'URL of new webhook' });
  addWebhook.addArgument(['-n', '--numConfirmations'], { help: 'Number of confirmations before calling webhook', defaultValue: 0 });
  addWebhook.addArgument(['-t', '--type'], { help: 'Type of webhook: e.g. transaction', defaultValue: 'transaction' });

  // removeWebhook
  const removeWebhook = subparsers.addParser('removeWebhook', {
    addHelp: true,
    help: 'Remove a webhook for the current wallet'
  });
  removeWebhook.addArgument(['-u', '--url'], { help: 'URL of webhook to remove' });
  removeWebhook.addArgument(['-t', '--type'], { help: 'Type of webhook: e.g. transaction', defaultValue: 'transaction' });

  const util = subparsers.addParser('util', {
    addHelp: true,
    help: 'Utilities for BitGo wallets'
  });
  const utilParser = util.addSubparsers({
    title: 'Utility commands',
    dest: 'utilCmd'
  });

  // recoverLitecoin
  const recoverLitecoin = utilParser.addParser('recoverltc', {
    addHelp: true,
    help: 'Helper tool to craft transaction to recover Litecoin mistakenly sent to BitGo Bitcoin multisig addresses on the Litecoin network'
  });
  recoverLitecoin.addArgument(['-t', '--txid'], { help: 'The tx id of the faulty transaction' });
  recoverLitecoin.addArgument(['-s', '--sourceWallet'], { help: 'The wallet ID the faulty transaction originated from' });
  recoverLitecoin.addArgument(['-r', '--recoveryWallet'], { help: 'The wallet ID of the BTC wallet that received the funds' });
  recoverLitecoin.addArgument(['-a', '--recoveryAddress'], { help: 'The address you wish to recover your bch to' });
  recoverLitecoin.addArgument(['--test'], { nargs: 0, help: 'use testnet' });

  const recoverBch = utilParser.addParser('recoverbch', {
    addHelp: true,
    help: 'Helper tool to craft transaction to recover BCH mistakenly sent to BitGo Bitcoin multisig addresses on the BTC network'
  });
  recoverBch.addArgument(['-t', '--txid'], { help: 'The tx id of the faulty transaction' });
  recoverBch.addArgument(['-s', '--sourceWallet'], { help: 'The wallet ID the faulty transaction originated from' });
  recoverBch.addArgument(['-r', '--recoveryWallet'], { help: 'The wallet ID of the BTC wallet that received the funds' });
  recoverBch.addArgument(['-a', '--recoveryAddress'], { help: 'The address you wish to recover your bch to' });
  recoverBch.addArgument(['--test'], { nargs: 0, help: 'use testnet' });

  const recoverBtc = utilParser.addParser('recoverbtc', {
    addHelp: true,
    help: 'Helper tool to craft transaction to recover BTC mistakenly sent to BitGo multisig addresses on the BCH network'
  });
  recoverBtc.addArgument(['-t', '--txid'], { help: 'The tx id of the faulty transaction' });
  recoverBtc.addArgument(['-s', '--sourceWallet'], { help: 'The wallet ID the faulty transaction originated from' });
  recoverBtc.addArgument(['-r', '--recoveryWallet'], { help: 'The wallet ID of the BTC wallet that received the funds' });
  recoverBtc.addArgument(['-a', '--recoveryAddress'], { help: 'The address you wish to recover your bch to' });
  recoverBtc.addArgument(['--test'], { nargs: 0, help: 'use testnet' });

  // recover BCH from migrated legacy safehd wallet
  const recoverBCHFromSafeHD = utilParser.addParser('recoversafehdbch', {
    addHelp: true,
    help: 'Helper tool to craft transaction to recover BCH from migrated legacy SafeHD wallets',
    usage: 'First, select the legacy SafeHD wallet from which you would like to recover the BCH:\n\tbitgo wallet [wallet]\nThen, run this command:\n\tbitgo util recoversafehdbch [-h] [-d DEST]'
  });
  recoverBCHFromSafeHD.addArgument(['-d', '--dest'], { help: 'the destination address' });

  // recover BTG from migrated legacy safehd wallet
  const recoverBTGFromSafeHD = utilParser.addParser('recoversafehdbtg', {
    addHelp: true,
    help: 'Helper tool to craft transaction to recover BTG from migrated legacy SafeHD wallets',
    usage: 'First, select the legacy SafeHD wallet from which you would like to recover the BTG:\n\tbitgo wallet [wallet]\nThen, run this command:\n\tbitgo util recoversafehdbtg [-h] [-d DEST]'
  });
  recoverBTGFromSafeHD.addArgument(['-d', '--dest'], { help: 'the destination address' });

  // help
  const help = subparsers.addParser('help', {
    addHelp: true,
    help: 'Display help'
  });
  help.addArgument(['command'], { nargs: '?' });
  /* eslint-enable no-unused-vars */

  return parser;
};

BGCL.prototype.handleUtil = function() {
  switch (this.args.utilCmd) {
    case 'recoverltc':
      return this.handleRecoverLitecoin();
    case 'recoverbch':
      return this.handleRecoverBCHFromBTCNonSegWit();
    case 'recoverbtc':
      return this.handleRecoverBTCFromBCH();
    case 'recoversafehdbch':
      return this.handleRecoverBCHFromSafeHD();
    case 'recoversafehdbtg':
      return this.handleRecoverBTGFromSafeHD();
    default:
      throw new Error('unknown command');
  }
};

BGCL.prototype.doPost = function(url, data, field) {
  data = data || {};
  return this.bitgo.post(this.bitgo.url(url)).send(data).result(field);
};

BGCL.prototype.doPut = function(url, data, field) {
  data = data || {};
  return this.bitgo.put(this.bitgo.url(url)).send(data).result(field);
};

BGCL.prototype.doGet = function(url, data, field) {
  data = data || {};
  return this.bitgo.get(this.bitgo.url(url)).query(data).result(field);
};

BGCL.prototype.doDelete = function(url, data, field) {
  data = data || {};
  return this.bitgo.del(this.bitgo.url(url)).send(data).result(field);
};

BGCL.prototype.toBTC = function(satoshis, decimals) {
  if (satoshis === 0) {
    return '0';
  }
  if (typeof(decimals) === 'undefined') {
    decimals = 4;
  }
  return (satoshis * 1e-8).toFixed(decimals);
};

BGCL.prototype.toBits = function(satoshis, decimals) {
  if (satoshis === 0) {
    return '0';
  }
  if (typeof(decimals) === 'undefined') {
    decimals = 2;
  }
  return (satoshis * 1e-2).toFixed(decimals);
};

BGCL.prototype.inBrackets = function(str) {
  return '[' + str + ']';
};

BGCL.prototype.info = function(line) {
  console.log(line);
};

BGCL.prototype.printJSON = function(obj) {
  this.info(JSON.stringify(obj, null, 2));
};

BGCL.prototype.action = function(line) {
  console.log('*** ' + line);
  console.log();
};

// Check if current session is using a long lived token and warn user if true
// Used to prevent a user from changing or possibly invalidating (in the case
// of a call to logout) the long-lived token.
BGCL.prototype.checkAndWarnOfLongLivedTokenChange = function(input, warning) {
  return this.bitgo.session()
  .then(function(res) {
    if (_.includes(_.keys(res), 'label')) {
      console.log(warning);
      return input.getVariable('confirm', 'Type \'go\' to confirm: ')()
      .then(function() {
        if (input.confirm !== 'go') {
          throw new Error('cancelling method call');
        }
      });
    }
  });
};


BGCL.prototype.header = function(line) {
  return line; // '> ' + line; // + ' ]';
};

BGCL.prototype.userHeader = function() {
  const user = this.bitgo.user();
  const username = user ? user.username : 'None';
  this.info('Current User: ' + username);
};

BGCL.prototype.walletHeader = function() {
  if (this.session.wallet) {
    console.log('Current wallet: ' + this.session.wallet.id());
  }
};

BGCL.prototype.formatWalletId = function(walletId) {
  const label = this.session.labelForWallet(walletId);
  if (label) {
    return _.string.prune(label, 22);
  }
  const shortened = _.string.prune(walletId, 12);
  return this.inBrackets('Wallet: ' + shortened);
};

BGCL.prototype.fetchLabels = function() {
  const self = this;
  return this.bitgo.labels()
  .then(function(labels) {
    self.session.labels = _.groupBy(labels, 'address');
    self.session.save();
    return labels;
  });
};

BGCL.prototype.fetchUsers = function(userIds) {
  const self = this;
  const userFetches = userIds.map(function(id) {
    return self.bitgo.getUser({ id: id });
  });
  return Q.all(userFetches);
};

BGCL.prototype.retryForUnlock = function(params, func) {
  const self = this;
  return func()
  .catch(function(err) {
    if (err.needsOTP) {
      // unlock and try again
      return self.handleUnlock(params).then(func);
    } else {
      throw err;
    }
  });
};

BGCL.prototype.getRandomPassword = function() {
  this.addEntropy(128);
  return bs58check.encode(new Buffer(sjcl.random.randomWords(7)));
};

BGCL.prototype.handleToken = function() {
  const self = this;

  // If no token set, display current one
  if (!this.args.token) {
    return self.ensureAuthenticated()
    .then(function() {
      self.info(self.bitgo._token);
    });
  }

  self.bitgo.clear();
  const input = new UserInput(this.args);
  return Q()
  .then(input.getVariable('token', 'Token: '))
  .then(function() {
    self.bitgo._token = input.token;
    return self.bitgo.me();
  })
  .then(function(user) {
    self.bitgo._user = user;
    self.session = new Session(self.bitgo);
    self.action('Logged in as ' + user.username);
    const promises = [];
    promises.push(self.fetchLabels());
    return Q.all(promises);
  })
  .catch(function(err) {
    if (err.status === 401) {
      throw new Error('Invalid token');
    }
    throw err;
  });
};

BGCL.prototype.handleLogin = function() {
  const self = this;
  self.bitgo.clear();
  const input = new UserInput(this.args);
  return Q()
  .then(input.getVariable('username', 'Email: '))
  .then(input.getVariable('password', 'Password: '))
  .then(input.getVariable('otp', '2-Step Verification Code: '))
  .then(function() {
    return self.bitgo.authenticate(input);
  })
  .then(function() {
    self.session = new Session(self.bitgo);
    self.action('Logged in as ' + input.username);
    const promises = [];
    promises.push(self.fetchLabels());
    return Q.all(promises);
  })
  .catch(function(err) {
    if (err.needsOTP) {
      throw new Error('Incorrect 2-step verification code.');
    }
    if (err.status === 401) {
      throw new Error('Invalid login/password');
    }
    throw err;
  });
};

BGCL.prototype.handleLogout = function() {
  const self = this;
  const input = new UserInput(this.args);
  return this.checkAndWarnOfLongLivedTokenChange(input, 'About to logout of a session with a longed-lived access token!\n' +
    'This will invalidate the long-lived access token, making it unusable in the future\n')
  .then(function() {
    return self.bitgo.logout();
  })
  .then(function() {
    self.action('Logged out');
  });
};

BGCL.prototype.handleStatus = function() {
  const self = this;
  const status = {
    env: this.bitgo.getEnv(),
    network: bitgo.getNetwork(),
    sessionFile: jsonFilename(this.bitgo.getEnv())
  };
  if (this.bitgo.user()) {
    status.user = this.bitgo.user().username;
  }
  if (this.session.wallet) {
    status.wallet = this.session.wallet.id();
  }
  return self.ensureAuthenticated()
  .then(function() {
    // JSON output
    if (self.args.json) {
      return self.printJSON(status);
    }

    // normal output
    self.info('Environment: ' + status.env);
    self.info('Network: ' + status.network);
    self.info('Session file: ' + status.sessionFile);
    self.userHeader();
    return self.ensureAuthenticated()
    .then(function() {
      self.walletHeader();
    });
  });
};

BGCL.prototype.handleOTPList = function() {
  const self = this;

  return this.bitgo.me()
  .then(function(user) {
    // JSON output
    if (self.args.json) {
      return self.printJSON(user.otpDevices);
    }

    // normal output
    self.info(_.string.rpad('ID', 34) + _.string.rpad('Type', 10) + 'Label');
    user.otpDevices.forEach(function(device) {
      self.info(_.string.rpad(device.id, 34) + _.string.rpad(device.type, 10) + device.label);
    });
  });
};

BGCL.prototype.handleOTPRemove = function() {
  const self = this;
  const deviceId = this.args.deviceId;
  return this.retryForUnlock({}, function() {
    return self.doDelete('/user/otp/' + deviceId)
    .then(function() {
      self.info('Removed');
    });
  });
};

BGCL.prototype.handleOTPAddYubikey = function() {
  const self = this;
  const input = new UserInput(this.args);
  return Q()
  .then(input.getVariable('otp', 'Enter Yubikey OTP: ', true))
  .then(input.getVariable('label', 'Label (optional): '))
  .then(function() {
    return self.retryForUnlock({}, function() {
      return self.doPut('/user/otp', { type: 'yubikey', otp: input.otp, label: input.label || undefined });
    });
  })
  .then(function() {
    self.info('Added');
  });
};

BGCL.prototype.handleOTPAddTOTP = function() {
  const self = this;
  let key;
  const input = new UserInput(this.args);
  const svgFile = BITGO_DIR + '/totp.svg';
  const htmlFile = BITGO_DIR + '/totp.html';

  return this.doGet('/user/otp/totp', {})
  .then(function(res) {
    key = res;
    fs.writeFileSync(svgFile, qr.imageSync(key.url, { type: 'svg' }));
    fs.writeFileSync(htmlFile, '<center><img src="totp.svg" width=256 height=256><h2 style="font-family:Helvetica">Scan with Google Authenticator</h2></center>');
    open(htmlFile);
  })
  .then(input.getVariable('otp', 'Scan QR Code in browser and enter numeric code: ', true))
  .then(input.getVariable('label', 'Label (optional): '))
  .then(function() {
    fs.unlinkSync(svgFile);
    fs.unlinkSync(htmlFile);
    return self.retryForUnlock({}, function() {
      const params = {
        type: 'totp',
        key: key.key,
        hmac: key.hmac,
        otp: input.otp,
        label: input.label || undefined
      };
      return self.doPut('/user/otp', params);
    });
  })
  .then(function() {
    self.info('Added');
  });
};

BGCL.prototype.handleOTPAdd = function() {
  const type = this.args.type;
  switch (type) {
    case 'yubikey':
      return this.handleOTPAddYubikey();
    case 'totp':
      return this.handleOTPAddTOTP();
    default:
      throw new Error('unsupported type');
  }
};

BGCL.prototype.handleOTP = function() {
  switch (this.args.cmd2) {
    case 'list':
      return this.handleOTPList();
    case 'add':
      return this.handleOTPAdd();
    case 'remove':
      return this.handleOTPRemove();
    default:
      throw new Error('unknown command');
  }
};

BGCL.prototype.printWalletList = function(wallets) {
  const self = this;
  // console.log(this.userHeader());
  // console.log();
  this.info('Wallets:');
  const width = (wallets.length - 1).toString().length;
  const rows = wallets.map(function(w, index) {
    let balance = self.toBTC(w.balance());
    balance = _.string.pad(balance, 10) + ' BTC';

    const marker = self.session.wallet.id() === w.id() ? '>> ' : '   ';
    return marker + _.string.pad(index, width) + '  ' + w.id() + '  ' + balance + '  ' + _.string.prune(w.label(), 20);
  });
  console.log(rows.join('\n'));
};

BGCL.prototype.handleWallets = function(setWallet) {
  const self = this;

  // Pre-process setWallet, if provided, to determine what type it is. It
  // may be a wallet id, an index, or a wallet name.
  let setWalletType;
  if (setWallet) {
    try {
      bitcoin.address.fromBase58Check(setWallet);
      setWalletType = 'id';
      return self.bitgo.wallets().get({ id: setWallet })
      .then(function(newWallet) {
        self.action('Set current wallet to ' + newWallet.id());
        self.session.wallet = newWallet;
        self.session.save();
        return [newWallet];
      });
    } catch (e) {
      const walletIndex = parseInt(setWallet, 10);
      // eslint-disable-next-line
      if (walletIndex == setWallet) {
        setWalletType = 'index';
        setWallet = walletIndex;
      } else {
        setWalletType = 'name';
      }
    }
  }

  const findWallet = function(w, index) {
    switch (setWalletType) {
      case 'index':
        return index === setWallet;
      case 'id':
        return w.id() === setWallet;
      case 'name':
        return w.label() === setWallet;
      default:
        throw new Error('unknown setWalletType');
    }
  };

  return self.bitgo.wallets().list()
  .then(function(result) {
    const wallets = result.wallets.filter(function(w) { return w.type() !== 'coinbase'; });

    // Save wallets map to session
    const sessionWallets = {};
    wallets.forEach(function(w) {
      sessionWallets[w.id()] = _.pick(w.wallet, ['id', 'label']);
    });
    self.session.wallets = sessionWallets;
    self.session.save();

    const walletIds = _.keys(sessionWallets);
    const fetches = walletIds.map(function(id) { return self.bitgo.wallets().get({ id: id }); });
    if (setWalletType === 'id' && !sessionWallets[setWallet]) {
      // getting an id which is not in the list, so it could be paged. add it in.
      fetches.push(self.bitgo.wallets().get({ id: setWallet }));
    }
    return Q.all(fetches);
  })
  .then(function(wallets) {
    const sortedWallets = _.sortBy(wallets, function(w) { return w.label() + w.id(); });

    // Find new current wallet id to set, based on setWallet param or default to index 0 if no current wallet
    let newWallet;
    if (setWalletType) {
      const wallet = _.find(sortedWallets, findWallet);
      newWallet = wallet;
    } else if (!self.session.wallet && sortedWallets.length) {
      newWallet = sortedWallets[0];
    }
    if (newWallet) {
      self.action('Set current wallet to ' + newWallet.id());
      self.session.wallet = newWallet;
      self.session.save();
    }

    // JSON output
    if (self.args.json) {
      return self.printJSON(sortedWallets);
    }

    // Normal output
    if (sortedWallets.length) {
      self.printWalletList(sortedWallets);
      self.info('\nCurrent wallet marked with >>. Use the wallet cmd to change.');
    } else {
      console.log('No wallets. Use the newwallet command to create one.');
    }
    return sortedWallets;
  });
};

BGCL.prototype.handleWallet = function() {
  if (!this.session.wallet) {
    throw new Error('No current wallet set. Use the setwallet command to set one.');
  }

  const self = this;
  let wallet;
  return this.bitgo.wallets().get({ id: this.session.wallet.id() })
  .then(function(result) {
    wallet = result;
    wallet.validateAddress({ address: wallet.wallet.id, path: '/0/0' });
    return wallet.createAddress({ allowExisting: '1' });
  })
  .then(function(address) {
    // JSON output
    if (self.args.json) {
      return self.printJSON(wallet.wallet);
    }

    // normal output
    const unconfirmed = (wallet.balance() !== wallet.confirmedBalance()) ? '  [ ** includes unconfirmed ]' : '';
    self.info('Current Wallet:');
    self.info('  Name:         ' + wallet.label());
    self.info('  ID:           ' + wallet.id());
    self.info('  Balance:      ' + self.toBTC(wallet.balance(), 8) + ' BTC' + unconfirmed);
    self.info('  Confirmed:    ' + self.toBTC(wallet.confirmedBalance(), 8) + ' BTC');
    self.info('  Recv address: ' + address.address + ' ' + self.inBrackets(address.index) );
  });
};

BGCL.prototype.handleBalance = function() {
  const self = this;

  const units = {
    s: 'satoshis',
    sat: 'satoshis',
    satoshi: 'satoshis',
    satoshis: 'satoshis',
    bit: 'bits',
    bits: 'bits',
    btc: 'btc',
    bitcoin: 'btc'
  };

  const unit = units[this.args.unit] || 'btc';

  const convert = function(balance) {
    switch (unit) {
      case 'satoshis':
        return balance.toFixed(0);
      case 'bits':
        return self.toBits(balance, 2);
      case 'btc':
        return self.toBTC(balance, 8);
    }
  };

  if (!this.session.wallet) {
    throw new Error('No current wallet set. Use the setwallet command to set one.');
  }
  return this.bitgo.wallets().get({ id: this.session.wallet.id() })
  .then(function(wallet) {
    // JSON output
    if (self.args.json) {
      const balances = {
        unit: unit,
        balance: Number(convert(wallet.balance())),
        confirmedBalance: Number(convert(wallet.confirmedBalance())),
        unconfirmedBalance: Number(convert(wallet.balance() - wallet.confirmedBalance()))
      };
      return self.printJSON(balances);
    }

    // normal output
    const balance = self.args.confirmed ? wallet.confirmedBalance() : wallet.balance();
    self.info(convert(balance));
  });
};

BGCL.prototype.handleLabels = function() {
  const self = this;
  let labelsByWallet = _.chain(this.session.labels).values().flatten().groupBy('walletId').value();

  if (!this.args.all) {
    const walletId = this.session.wallet.id();
    const labels = labelsByWallet[walletId] || [];
    labelsByWallet = {};
    labelsByWallet[walletId] = labels;
  }

  // JSON output
  if (this.args.json) {
    return this.printJSON(labelsByWallet);
  }

  // normal output
  const sortedWallets = _.sortBy(_.values(this.session.wallets), function(w) { return w.label + w.id; });
  sortedWallets.forEach(function(wallet) {
    const labels = labelsByWallet[wallet.id];
    if (labels) {
      const sortedLabels = _.sortBy(labels, function(label) { return label.label + label.address; });
      self.info(wallet.label);
      sortedLabels.forEach(function(label) {
        const line = '  ' + _.string.rpad(label.address, 38) + _.string.prune(label.label, 60);
        self.info(line);
      });
    }
  });
};

BGCL.prototype.handleSetLabel = function() {
  const self = this;

  const wallet = this.session.wallet;
  const address = this.args.address;
  const label = this.args.label;

  return this.ensureWallet()
  .then(function() {
    return wallet.setLabel({ address: address, label: label });
  })
  .then(function(result) {
    self.action('Labeled ' + address + " to '" + label + "' in wallet '" + wallet.label() + "'");
    return self.fetchLabels();
  });
};

BGCL.prototype.handleRemoveLabel = function() {
  const self = this;

  const wallet = this.session.wallet;
  const address = this.args.address;

  return this.ensureWallet()
  .then(function() {
    return wallet.deleteLabel({ address: address });
  })
  .then(function(result) {
    self.action('Removed label for ' + address + " in wallet '" + wallet.label() + "'");
    return self.fetchLabels();
  });
};

BGCL.prototype.handleAddresses = function() {
  const printAddressList = function(addresses) {
    const rows = addresses.map(function(a) {
      const balance = self.toBTC(a.balance);
      const received = self.toBTC(a.received);
      return _.string.pad(a.index, 3) + ' : ' +
        _.string.rpad(a.address, 35) +
        _.string.pad(received, 14) +
        _.string.pad(balance, 14) +
        _.string.pad(a.txCount, 8);
    });
    console.log('      ' +
      _.string.rpad('Address', 35) +
      _.string.pad('Received', 14) +
      _.string.pad('Balance', 14) +
      _.string.pad('nTx', 8)
    );
    console.log(rows.join('\n'));
  };

  const self = this;
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  const wallet = this.session.wallet;
  const queries = [];
  queries.push(wallet.addresses({ chain: 0, limit: 200, details: '1' }));
  if (this.args.change) {
    queries.push(wallet.addresses({ chain: 1, limit: 200, details: '1' }));
  }

  return Q.spread(queries, function(receiveAddresses, changeAddresses) {
    // JSON output
    if (self.args.json) {
      const json = {
        receive: receiveAddresses.addresses
      };
      if (changeAddresses) {
        json.change = changeAddresses.addresses;
      }
      return this.printJSON(json);
    }
    // normal output
    self.walletHeader();
    self.info('\nReceive Addresses:');
    printAddressList(receiveAddresses.addresses);
    if (changeAddresses) {
      self.info('\nChange Addresses:');
      printAddressList(changeAddresses.addresses);
    }
  });
};

BGCL.prototype.handleNewAddress = function() {
  const self = this;
  const wallet = this.session.wallet;
  const label = this.args.label;
  let address;

  if (!wallet) {
    throw new Error('No current wallet.');
  }
  const params = {
    chain: this.args.change ? 11 : 10
  };
  return wallet.createAddress(params)
  .then(function(result) {
    address = result;
    if (label) {
      const url = self.bitgo.url('/labels/' + wallet.id() + '/' + address.address);
      return self.bitgo.put(url)
      .send({ label: label })
      .result()
      .then(function() {
        return self.fetchLabels();
      });
    }
  })
  .then(function() {
    // JSON output
    if (self.args.json) {
      return self.printJSON(address);
    }
    // normal output
    self.info(address.address);
  });
};

BGCL.prototype.handleUnspents = function() {
  const self = this;
  const minconf = this.args.minconf || 0;
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  return this.session.wallet.unspents()
  .then(function(unspents) {
    // JSON output
    if (self.args.json) {
      return self.printJSON(unspents);
    }

    let total = 0;
    self.info('Conf' + '  ' +
      _.string.lpad('Amount', 11) + '  ' +
      _.string.rpad('Address', 35) + '  ' +
      'Tx:vout');
    unspents.forEach(function(u) {
      if (u.confirmations >= minconf) {
        total += u.value;
        self.info(
          _.string.lpad(u.confirmations, 4) + '  ' +
          _.string.lpad(self.toBTC(u.value), 11) + '  ' +
          _.string.rpad(u.address, 35) + '  ' +
          u.tx_hash + ':' + u.tx_output_n + ' ' +
          u.isChange
        );
      }
    });
    self.info('\nTotal: ' + self.toBTC(total));
  });
};

BGCL.prototype.handleFanoutUnspents = function() {
  const self = this;
  const input = new UserInput(this.args);
  const target = this.args.target;
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }

  const fanoutParams = {
    target: target,
    xprv: this.args.xprv
  };

  if (Number.isInteger(this.args.minConfirms) && this.args.minConfirms >= 0) {
    fanoutParams.minConfirms = this.args.minConfirms;
  }

  return this.ensureWallet()
  .then(function() {
    if (!self.args.xprv) {
      return input.getVariable('password', 'Wallet password: ')();
    }
  })
  .then(function() {
    fanoutParams.walletPassphrase = input.password;
    return self.retryForUnlock({ duration: 3600 }, function() {
      return self.session.wallet.fanOutUnspents(fanoutParams);
    });
  })
  .then(function(fanoutTransaction) {
    if (self.args.json) {
      return self.printJSON(fanoutTransaction);
    }
    self.info('\nUnspents have been fanned out.');
  });
};

BGCL.prototype.handleConsolidateUnspents = function() {
  const self = this;
  const input = new UserInput(this.args);
  const target = this.args.target || 1;
  const maxInputCount = this.args.inputCount || undefined;
  const minSize = this.args.minSize || 0;
  const maxSize = (this.args.maxSize === '') ? 0.25 : parseFloat(this.args.maxSize);

  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }

  const maxSatoshis = Math.ceil(maxSize * 1e8);

  const progressCallback = function(data) {
    if (self.args.json) {
      return self.printJSON(data);
    }
    self.info(data.index + ': Sent ' + data.inputCount + '-input tx ' + data.txid + ' for ' +
      self.toBTC(data.amount, 4) + 'BTC with fee of ' +
      self.toBTC(data.fee, 8) + ' BTC to ' +
      data.destination.address);
  };

  const params = {
    target: target,
    minSize: minSize,
    maxSize: maxSatoshis,
    maxInputCountPerConsolidation: maxInputCount,
    progressCallback: progressCallback,
    feeRate: this.args.feeRate || undefined,
    feeTxConfirmTarget: this.args.confirmTarget || undefined,
    xprv: this.args.xprv
  };

  if (Number.isInteger(this.args.maxIterationCount) && this.args.maxIterationCount >= 0) {
    params.maxIterationCount = this.args.maxIterationCount;
  }

  if (Number.isInteger(this.args.minConfirms) && this.args.minConfirms >= 0) {
    params.minConfirms = this.args.minConfirms;
  }

  return this.ensureWallet()
  .then(function() {
    if (!self.args.xprv) {
      return input.getVariable('password', 'Wallet password: ')();
    }
  })
  .then(function() {
    params.walletPassphrase = input.password;
    return self.retryForUnlock({ duration: 3600 }, function() {
      return self.session.wallet.consolidateUnspents(params);
    });
  })
  .then(function(transactions) {
    if (self.args.json) {
      return self.printJSON(transactions);
    }
    self.info('\nUnspents have been consolidated.');
  });
};

BGCL.prototype.handleTxList = function() {
  const printTxList = function(txlist) {
    const rows = txlist.map(function(tx) {
      const date = new moment(tx.date).format('YYYY-MM-DD HH:mm');
      let inout = tx.amount > 0 ? 'recv' : 'send';
      let prep = tx.amount > 0 ? 'on' : 'to';
      if (tx.otherWalletId) {
        inout = 'xfer';
        prep = tx.amount > 0 ? 'from' : 'to';
      }
      let amount = self.toBTC(tx.amount);
      if (tx.amount > 0) {
        amount = '+' + amount;
      }
      const pending = tx.state === 'unconfirmed' ? '* ' : '  ';
      let target = '';
      if (tx.otherWalletId) {
        if (tx.otherWalletId === tx.walletId) {
          target = 'self';
        } else {
          target = self.formatWalletId(tx.otherWalletId);
        }
      } else if (tx.toAddress) {
        target = self.session.labelForAddress(tx.toAddress) || tx.toAddress;
        target = _.string.prune(target, 35);
      }
      if (!target) {
        prep = '       ';
      } else {
        prep = inout + ' ' + prep;
      }
      let row = pending + date + '  ' +
        _.string.lpad(amount, 10) + '  ' + prep + ' ' +
        _.string.rpad(target, 38) + tx.transactionId;

      if (tx.comment) {
        row = row + '\n' + _.string.lpad('', 32) + '# ' + _.string.truncate(tx.comment, 42);
      }
      return row;
    });
    self.info('Transactions:');
    console.log();
    console.log('  ' +
      _.string.rpad('Date', 11) +
      _.string.rpad('Time', 7) +
      _.string.lpad('Amt', 11) + '  ' +
      _.string.rpad('Description', 42)
    );
    console.log();
    console.log(rows.join('\n'));
  };

  const transactions = [];

  const getTransactions = function(skip, target) {
    let limit = target - transactions.length;
    if (limit <= 0) {
      return;
    }
    if (limit > 500) {
      // Server enforces 500 max
      limit = 500;
    }
    const url = self.session.wallet.url('/wallettx?skip=' + skip + '&limit=' + limit);
    return self.bitgo.get(url).result()
    .then(function(result) {
      result.transactions.forEach(function(tx) {
        transactions.push(tx);
      });
      if (result.transactions.length < limit) {
        return;
      }
      return getTransactions(skip + limit, target);
    });
  };

  const self = this;
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  const limit = this.args.n || 25;
  return Q().then(function() {
    return getTransactions(0, limit);
  })
  .then(function() {
    // JSON output
    if (self.args.json) {
      return self.printJSON(transactions);
    }
    // normal output
    self.walletHeader();
    printTxList(transactions);
  });
};

/**
 * Handles the unlocking of a session by prompting for the 2FA code.
 * @param params Additional arguments that can be passed iff this method is called programmatically
 *  - duration: Duration in seconds for the unlock period
 * @returns {*}
 */
BGCL.prototype.handleUnlock = function(params) {
  params = params || {};
  const self = this;
  const input = new UserInput(this.args);
  return this.checkAndWarnOfLongLivedTokenChange(input, 'About to unlock a longed-lived access token!\n' +
  'This will also unlock the token for any other users who have access to it\n')
  .then(function() {
    return Q();
  })
  .then(function() {
    if (!input.otp) {
      // this triggers a push
      return self.bitgo.sendOTP();
    }
  })
  .then(input.getVariable('otp', '2-step Verification Code: ', true))
  .then(function() {
    const unlockOptions = { otp: input.otp };
    if (typeof(params.duration) === 'number') {
      unlockOptions.duration = params.duration;
    }
    return self.bitgo.unlock(unlockOptions);
  })
  .then(function() {
    self.action('Unlocked session');
  });
};

BGCL.prototype.handleLock = function() {
  const self = this;
  const input = new UserInput(this.args);
  return this.checkAndWarnOfLongLivedTokenChange(input, 'About to lock a longed-lived access token!\n' +
    'This will also lock the token for any other users who have access to it\n')
  .then(function() {
    return self.bitgo.lock();
  })
  .then(function() {
    self.action('Locked session');
  });
};

BGCL.prototype.handleShares = function() {
  const self = this;
  let shares;

  const printShareList = function(shares, users, incoming) {
    const rows = shares.map(function(share) {
      const marker = share.state === 'pendingapproval' ? '* ' : '  ';
      const userId = incoming ? share.fromUser : share.toUser;
      const user = users[userId];
      const email = user ? user.email.email : '';
      const role = permsToRole[share.permissions] || share.permissions;
      const row = marker + _.string.rpad(share.id, 34) +
        _.string.rpad(role, 9) +
        _.string.rpad(email, 20) +
        _.string.rpad(_.string.prune(share.walletLabel, 18), 20) +
        _.string.prune(share.message, 40);
      return row;
    });

    const userField = incoming ? 'From' : 'To';
    const header = '  ' + _.string.rpad('ID', 34) +
      _.string.rpad('Role', 9) +
      _.string.rpad(userField, 20) +
      _.string.rpad('Wallet', 20) + 'Message';
    self.info(header);
    self.info(rows.join('\n'));
  };

  return this.ensureAuthenticated()
  .then(function() {
    return self.bitgo.wallets().listShares();
  })
  .then(function(result) {
    shares = result;
    let userIds = _.pluck(shares.incoming, 'fromUser');
    userIds = userIds.concat(_.pluck(shares.outgoing, 'toUser'));
    userIds = _.uniq(userIds);
    return self.fetchUsers(userIds);
  })
  .then(function(users) {
    // JSON output
    if (self.args.json) {
      return self.printJSON(shares);
    }

    // normal output
    const indexedUsers = _.indexBy(users, 'id');
    if (shares.incoming.length) {
      self.info('\nIncoming Shares:');
      printShareList(shares.incoming, indexedUsers, true);
    }
    if (shares.outgoing.length) {
      self.info('\nOutgoing Shares:');
      printShareList(shares.outgoing, indexedUsers, false);
    }
  });
};

BGCL.prototype.handleShareWallet = function() {
  const self = this;
  const input = new UserInput(this.args);
  const walletId = this.args.wallet || this.session.wallet.id();
  let wallet;

  return this.ensureWallet()
  .then(function() {
    self.info('Share Wallet ' + walletId + ':\n');
    return self.bitgo.wallets().get({ id: walletId });
  })
  .then(function(result) {
    wallet = result;
    if (!wallet.wallet.admin) {
      throw new Error('can\'t share wallet: not an admin');
    }
  })
  .then(input.getVariable('email', 'Email address of recipient: ', true))
  .then(input.getVariable('role', 'Role ( [a]dmin | [s]pender | [v]iewer ): ', true))
  .then(input.getVariable('comment', 'Optional comment for recipient: '))
  .then(function() {
    input.permissions = (function() {
      switch (input.role) {
        case 'v':
        case 'viewer':
          return 'view';
        case 's':
        case 'spender':
          return 'spend,view';
        case 'a':
        case 'admin':
          return 'admin,spend,view';
        default:
          throw new Error('unsupported role');
      }
    })();

    if (input.permissions.indexOf('spend') !== -1) {
      return input.getVariable('password', 'Wallet password: ', true)();
    }
  })
  .then(function() {
    return self.retryForUnlock({}, function() {
      return wallet.shareWallet({
        email: input.email,
        permissions: input.permissions,
        message: input.comment,
        walletPassphrase: input.password
      });
    });
  })
  .then(function(result) {
    self.action('Wallet share created (id=' + result.id + ')');
  });
};

BGCL.prototype.handleAcceptShare = function() {
  const self = this;
  const input = new UserInput(this.args);

  return this.ensureAuthenticated()
  .then(input.getVariable('password', 'BitGo Password: ', true))
  .then(function() {
    return self.bitgo.verifyPassword({ password: input.password });
  })
  .then(function(validPassword) {
    if (!validPassword) {
      throw new Error('invalid password');
    }
    return self.retryForUnlock({}, function() {
      return self.bitgo.wallets().acceptShare({
        walletShareId: input.share,
        userPassword: input.password
      });
    });
  })
  .then(function(result) {
    if (result.changed) {
      self.action('Wallet share ' + result.state);
      if (result.state === 'accepted') {
        return self.handleWallets(result.walletId);
      }
    } else {
      self.info('Wallet share was already accepted');
    }
  });
};

BGCL.prototype.handleCancelShare = function() {
  const self = this;
  const input = new UserInput(this.args);

  return this.ensureAuthenticated()
  .then(function() {
    return self.bitgo.wallets().cancelShare({ walletShareId: input.share });
  })
  .then(function(result) {
    if (result.changed) {
      self.action('Wallet share ' + result.state);
    } else {
      self.info('Wallet share was already canceled');
    }
  });
};

BGCL.prototype.handleFreezeWallet = function() {
  const self = this;
  const input = new UserInput(this.args);

  return this.ensureWallet()
  .then(function() {
    return input.getIntVariable('duration', 'Duration in seconds to freeze: ', true, 1, 1e8)();
  })
  .then(function() {
    self.info("Please confirm you wish to freeze wallet '" + self.session.wallet.label() + "' for " + input.duration + ' seconds.');
    self.info('BitGo will not sign any transactions on this wallet until the freeze expires.');
    return input.getVariable('confirm', 'Type \'go\' to confirm: ')();
  })
  .then(function() {
    if (input.confirm !== 'go') {
      throw new Error('canceled');
    }
    return self.session.wallet.freeze({ duration: input.duration });
  })
  .then(function(result) {
    self.info('Wallet frozen until ' + result.expires);
  });
};

BGCL.prototype.handleRemoveWallet = function() {
  const self = this;
  const input = new UserInput(this.args);
  const walletId = this.args.wallet || this.session.wallet.id();

  return this.ensureWallet()
  .then(function() {
    return input.getVariable('confirm', 'Type \'yes\' to confirm removing wallet ' + walletId + ': ')();
  })
  .then(function() {
    if (input.confirm !== 'yes') {
      throw new Error('canceled');
    }
    return self.bitgo.wallets().remove({ id: walletId });
  })
  .then(function() {
    self.action('Removed wallet ' + walletId);
  });
};

BGCL.prototype.handleSendToAddress = function() {
  const self = this;
  const input = new UserInput(this.args);
  let satoshis;
  let txParams;
  const wallet = this.session.wallet;

  return this.ensureWallet()
  .then(function() {
    self.walletHeader();
    console.log();
    self.info('Send Transaction:\n');
  })
  .then(input.getVariable('dest', 'Destination address: '))
  .then(input.getVariable('amount', 'Amount (in BTC): '))
  .then(input.getVariable('password', 'Wallet password: '))
  .then(input.getVariable('comment', 'Optional comment: '))
  .then(function() {
    input.comment = input.comment || undefined;
    try {
      bitcoin.address.fromBase58Check(input.dest);
    } catch (e) {
      throw new Error('Invalid destination address');
    }
    satoshis = Math.floor(Number(input.amount) * 1e8);
    if (isNaN(satoshis)) {
      throw new Error('Invalid amount (non-numeric)');
    }
    txParams = {
      recipients: [{ address: input.dest, amount: satoshis }],
      walletPassphrase: input.password,
      message: input.comment,
      minConfirms: input.unconfirmed ? 0 : 1,
      enforceMinConfirmsForChange: true,
      changeAddress: wallet.id()
    };

    return wallet.createTransaction(txParams)
    .catch(function(err) {
      if (err.needsOTP) {
        // unlock
        return self.handleUnlock()
        .then(function() {
          // try again
          return wallet.createTransaction(txParams);
        });
      } else {
        throw err;
      }
    });
  })
  .then(function(txResult) {
    const amounts = [];
    amounts.push(util.format('BTC %s', self.toBTC(txParams.recipients[0].amount)));
    if (txResult.bitgoFee) {
      amounts.push(util.format('%s BitGo fee', self.toBTC(txResult.bitgoFee.amount)));
    }
    amounts.push(util.format('%s blockchain fee', self.toBTC(txResult.fee)));
    const prefix = input.confirm ? 'Sending' : 'Please confirm sending';
    self.info(prefix + ' ' + amounts.join(' + ') + ' to ' + txParams.recipients[0].address + '\n');
    return input.getVariable('confirm', 'Type \'go\' to confirm: ')();
  })
  .then(function() {
    if (input.confirm !== 'go') {
      throw new Error('Transaction canceled');
    }

    delete txParams.changeAddress;
    return wallet.sendMany(txParams)
    .catch(function(err) {
      if (err.needsOTP) {
        // unlock
        return self.handleUnlock()
        .then(function() {
          // try again
          return wallet.sendMany(txParams);
        });
      } else {
        throw err;
      }
    });
  })
  .then(function(tx) {
    if (tx.hash) {
      self.action('Sent transaction ' + tx.hash);
    } else {
      if (tx.status === 'pendingApproval') {
        self.info('Transaction triggered policy - ' + tx.error);
        self.info('Pending approval ID: ' + tx.pendingApproval);
      }
    }
  });
};

BGCL.prototype.handleCreateTx = function() {
  const self = this;
  const input = new UserInput(this.args);
  let satoshis;

  return this.ensureWallet()
  .then(function () {
    self.walletHeader();
    self.info('Create Unsigned Transaction\n');
  })
  .then(input.getVariable('dest', 'Destination address: '))
  .then(input.getVariable('amount', 'Amount (in BTC): '))
  .then(input.getVariable('fee', 'Blockchain fee (blank to use default fee calculation): '))
  .then(input.getVariable('comment', 'Optional private comment: '))
  .then(function() {
    input.comment = input.comment || undefined;
    try {
      bitcoin.address.fromBase58Check(input.dest);
    } catch (e) {
      throw new Error('Invalid destination address');
    }
    satoshis = Math.floor(Number(input.amount) * 1e8);
    if (isNaN(satoshis)) {
      throw new Error('Invalid amount (non-numeric)');
    }
    return self.bitgo.wallets().get({ id: self.session.wallet.id() });
  })
  .then(function(wallet) {
    const recipients = {};
    recipients[input.dest] = satoshis;
    const params = {
      recipients: recipients,
      minConfirms: input.unconfirmed ? 0 : 1,
      enforceMinConfirmsForChange: true
    };

    if (input.fee) {
      params.fee = Math.floor(Number(input.fee) * 1e8);
      if (isNaN(params.fee)) {
        throw new Error('Invalid fee (non-numeric)');
      }
    }

    return wallet.createTransaction(params)
    .catch(function(err) {
      if (err.needsOTP) {
        // unlock
        return self.handleUnlock()
        .then(function() {
          // try again
          return wallet.createTransaction(params);
        });
      } else {
        throw err;
      }
    });
  })
  .then(function(tx) {
    self.info('Created unsigned transaction for ' + self.toBTC(satoshis) + ' BTC + ' + tx.fee / 1e8 + ' BTC blockchain fee to ' + input.dest + '\n');
    tx.comment = input.comment;
    if (!input.prefix) {
      input.prefix = 'tx' + moment().format('YYYYMDHm');
    }
    const filename = input.prefix + '.json';
    fs.writeFileSync(filename, JSON.stringify(tx, null, 2));
    console.log('Wrote ' + filename);
  });
};

BGCL.prototype.handleSignTx = function() {
  const self = this;
  const input = new UserInput(this.args);
  let params;
  let wallet;

  return Q()
  .then(input.getVariable('file', 'Input transaction file: '))
  .then(input.getVariable('key', 'Private BIP32 key (xprv): '))
  .then(function() {
    // Grab transaction data (hex, wallet info) from the json file
    const json = fs.readFileSync(input.file);
    params = JSON.parse(json);
    return self.bitgo.newWalletObject({ wallet: { id: params.walletId }, private: { keychains: params.walletKeychains } });
  })
  .then(function(result) {
    wallet = result;

    // Validate inputs
    let hdNode;
    try {
      hdNode = bitcoin.HDNode.fromBase58(input.key);
    } catch (e) {
      throw new Error('invalid private key');
    }

    if (hdNode.toBase58() === hdNode.neutered().toBase58()) {
      throw new Error('must provide the private (not public) key');
    }

    const pubKey = hdNode.neutered().toBase58();
    const xpubs = _.initial(_.pluck(wallet.keychains, 'xpub'));
    if (!_.includes(xpubs, pubKey)) {
      throw new Error('did not provide a private key valid for the wallet that created this transaction');
    }

    params.keychain = {
      xpub: pubKey,
      path: 'm',
      xprv: input.key
    };

    // validate  the change address is owned by the wallet
    let changeAddress;
    if (params.changeAddress && params.changeAddress.address) {
      wallet.validateAddress(params.changeAddress);
      changeAddress = params.changeAddress.address;
    }
    // validate the wallet id is the first address
    wallet.validateAddress({ address: params.walletId, path: '/0/0' });

    const transaction = bitcoin.Transaction.fromHex(params.transactionHex);

    self.info('You are signing a transaction from the wallet: ' + params.walletId);
    if (params.comment) {
      self.info('Comment: ' + params.comment);
    }

    for (let i = 0; i < transaction.outs.length; i++) {
      let outputAddress = bitcoin.address.fromOutputScript(transaction.outs[i].script, bitcoin.getNetwork());
      if (changeAddress === outputAddress) {
        outputAddress += ' (verified change address back to wallet)';
      }
      self.info('Output #' + (i + 1) + ': ' + transaction.outs[i].value / 1e8 + ' BTC to ' + outputAddress);
    }

    return input.getVariable('confirm', 'Type \'go\' to confirm: ')();
  })
  .then(function() {
    if (input.confirm !== 'go') {
      throw new Error('Transaction canceled');
    }
    return wallet.signTransaction(params);
  })
  .then(function(tx) {
    self.info('Signed transaction using the key provided. ');
    tx.comment = params.comment;
    if (!input.prefix) {
      // if output prefix not provided, use the input file
      input.prefix = input.file.replace(/\.[^/.]+$/, '');
    }
    const filename = input.prefix + '.signed.json';
    fs.writeFileSync(filename, JSON.stringify(tx, null, 2));
    console.log('Wrote ' + filename);
  });
};

BGCL.prototype.handleSendTx = function() {
  const self = this;
  const input = new UserInput(this.args);
  let wallet;
  let params;

  return this.ensureWallet()
  .then(function () {
    self.walletHeader();
    self.info('Send Transaction\n');
    return self.bitgo.wallets().get({ id: self.session.wallet.id() });
  })
  .then(function(result) {
    wallet = result;
    if (input.txhex || input.file) {
      return;
    }
    return input.getVariable('txInput', 'Transaction (hex or file): ')();
  })
  .then(function() {
    if (input.txInput) {
      if (fs.existsSync(input.txInput)) {
        input.file = input.txInput;
      } else {
        try {
          bitcoin.Transaction.fromHex(input.txInput);
        } catch (e) {
          throw new Error('Input was not a valid path or transaction hex');
        }
        input.txhex = input.txInput;
      }
    }

    if (!(!!input.txhex ^ !!input.file)) {
      throw new Error('must provide either txhex or file');
    }

    if (input.file) {
      const json = fs.readFileSync(input.file);
      params = JSON.parse(json);
    } else {
      params = {};
      params.tx = input.txhex;
      return input.getVariable('comment', 'Optional private comment: ')()
      .then(function() {
        params.comment = input.comment;
      });
    }
  })
  .then(function() {
    return wallet.sendTransaction(params)
    .catch(function(err) {
      if (err.needsOTP) {
        // unlock
        return self.handleUnlock()
        .then(function() {
          // try again
          return wallet.sendTransaction(params);
        });
      } else {
        throw err;
      }
    });
  })
  .then(function(tx) {
    self.action('Sent transaction ' + tx.hash);
  });
};

BGCL.prototype.genKey = function() {
  this.addEntropy(128);
  const seedLength = 256 / 32; // 256 bits / 32-bit words
  const seed = sjcl.codec.hex.fromBits(sjcl.random.randomWords(seedLength));
  const extendedKey = bitcoin.HDNode.fromSeedHex(seed);
  return {
    seed: seed,
    xpub: extendedKey.neutered().toBase58(),
    xprv: extendedKey.toBase58()
  };
};

BGCL.prototype.handleNewKey = function() {
  if (this.args.entropy) {
    this.addUserEntropy(this.args.entropy);
  }
  this.addEntropy(128);
  const key = this.genKey();
  // JSON output
  if (this.args.json) {
    return this.printJSON(key);
  }

  // normal output
  this.info('Seed:  ' + key.seed);
  this.info('xprv:  ' + key.xprv);
  this.info('xpub:  ' + key.xpub);
};

BGCL.prototype.handleEncryptKey = function() {
  const self = this;
  const input = new UserInput(this.args);
  return Q().then(function() {
    return input.getVariable('xprv', 'xprv: ', true)();
  }).then(function() {
    return input.getVariable('password', 'password to encrypt with: ', true)();
  }).then(input.getVariable('prefix', "File prefix [default = 'encryptedKey']: ", false, 'encryptedKey'))
  .then(function() {
    let key;
    try {
      key = bitcoin.HDNode.fromBase58(input.xprv);
    } catch (e) {
      throw new Error('Invalid BIP32 key');
    }
    const encryptedXprv = self.bitgo.encrypt({
      password: input.password,
      input: input.xprv
    });
    const params = {
      xprv: encryptedXprv,
      xpub: key.neutered().toBase58()
    };
    const filename = input.prefix + '.json';
    fs.writeFileSync(filename, JSON.stringify(params, null, 2));
    console.log('Wrote ' + filename);
  });
};

BGCL.prototype.handleNewWallet = function() {
  const self = this;
  const input = new UserInput(this.args);

  let userkey;
  let backupkey;

  let userKeychain;
  let backupKeychain;
  let bitgoKeychain;

  const getPassword = function() {
    return input.getPassword('password', 'Enter BitGo password: ')()
    .then(function() {
      return self.bitgo.verifyPassword({ password: input.password });
    })
    .then(function(valid) {
      if (!valid) {
        self.info('Incorrect password - try again');
        delete input.password;
        return getPassword();
      }
    });
  };

  return this.ensureAuthenticated()
  .then(function() {
    self.userHeader();
    console.log('Create New Wallet');
    console.log();
    if (!input.userkey) {
      console.log('First, we need the user keychain. Enter a BIP32 xprv below, or press');
      console.log('return to generate one automatically. Your user key is encrypted locally');
      console.log('with your password, and stored on BitGo\'s server.');
      console.log();
      return input.getVariable('userkey', 'User key (xprv or xpub): ')();
    }
  })
  .then(function() {
    if (input.userkey === '') {
      const keychain = self.bitgo.keychains().create();
      input.userkey = keychain.xprv;
      self.action('Created user key: ' + keychain.xpub);
    }
    try {
      userkey = bitcoin.HDNode.fromBase58(input.userkey);
    } catch (e) {
      throw new Error('Invalid BIP32 key');
    }

    if (!input.backupkey) {
      console.log();
      console.log('Next, we need the backup keychain. Enter a BIP32 xpub below. It is recommended');
      console.log('to generate the backup keychain on a different machine using reliable');
      console.log('BIP32 key generation software. For instance, you can use the \'keychain\'');
      console.log('sub-command to generate a keychain');
      console.log();

      return input.getVariable('backupkey', 'Backup key (xpub): ', true)();
    }
  })
  .then(function() {
    try {
      if (input.backupkey.substr(0, 4) !== 'xpub') { throw new Error(); }
      backupkey = bitcoin.HDNode.fromBase58(input.backupkey);
    } catch (e) {
      throw new Error('Invalid BIP32 xpub for backup key');
    }
  })
  .then(input.getVariable('name', 'Name this wallet: '))
  .then(getPassword)
  .then(function() {
    // Create user keychain
    userKeychain = {
      xpub: userkey.neutered().toBase58()
    };
    if (userkey.neutered().toBase58() !== userkey.toBase58()) {
      userKeychain.encryptedXprv = self.bitgo.encrypt({
        password: input.password,
        input: userkey.toBase58()
      });
      userKeychain.passcodeRecoveryCode = self.getRandomPassword();
    }
    return self.bitgo.keychains().add(userKeychain);
  })
  .then(function(keychain) {
    // Create backup keychain
    backupKeychain = {
      xpub: backupkey.neutered().toBase58()
    };
    return self.bitgo.keychains().add(backupKeychain);
  })
  .then(function(keychain) {
    // Create BitGo keychain
    return self.bitgo.keychains().createBitGo();
  })
  .then(function(keychain) {
    // Create the wallet
    bitgoKeychain = keychain;
    const walletParams = {
      label: input.name,
      m: 2,
      n: 3,
      keychains: [
        { xpub: userKeychain.xpub },
        { xpub: backupKeychain.xpub },
        { xpub: bitgoKeychain.xpub }]
    };
    return self.bitgo.wallets().add(walletParams);
  })
  .then(function(wallet) {
    self.action('Created wallet ' + wallet.id());

    const recovery = {
      info: 'Recovery information for wallet ' + wallet.id() + ' (' + wallet.label() + ')',
      keys: {
        user: {
          xpub: userKeychain.xpub,
          encryptedXprv: userKeychain.encryptedXprv
        },
        backup: {
          xpub: backupKeychain.xpub
        },
        bitgo: {
          xpub: bitgoKeychain.xpub
        }
      }
    };

    if (userKeychain.passcodeRecoveryCode) {
      recovery.keys.user.encryptedPassword = sjcl.encrypt(userKeychain.passcodeRecoveryCode, input.password);
    }

    const recoveryFile = jsonFilename('recovery.' + wallet.id());
    fs.writeFileSync(recoveryFile, JSON.stringify(recovery, null, 2));
    self.action('Wrote wallet recovery info to ' + recoveryFile);

    return self.handleWallets(wallet.id());
  });
};

/**
 * Add n bytes of entropy to the SJCL entropy pool from secure crypto
 * @param {Number} nBytes   number of bytes to add
 */
BGCL.prototype.addEntropy = function(nBytes) {
  const buf = crypto.randomBytes(nBytes).toString('hex');
  // Will throw if the system pool is out of entropy
  sjcl.random.addEntropy(buf, nBytes * 8, 'crypto.randomBytes');
};

BGCL.prototype.addUserEntropy = function(userString) {
  // estimate 2 bits of entropy per character
  sjcl.random.addEntropy(userString, userString.length * 2, 'user');
};

/**
 * Generate a new BIP32 key based on a random seed, returning
 * the xpub, along with the encrypted split shares for the seed.
 *
 * @param   {Object} params  the UserInput object with params
 * @param   {Number} index   the index of the key in the batch
 * @returns {Object}         information about the key
 */
BGCL.prototype.genSplitKey = function(params, index) {
  const self = this;
  const key = this.genKey();
  const result = {
    xpub: key.xpub,
    m: params.m,
    n: params.n
  };

  // If n==1, we're not splitting, just encrypt
  let shares;
  if (params.n === 1) {
    shares = [key.seed];
  } else {
    shares = secrets.share(key.seed, params.n, params.m);
  }

  const encryptedShares = shares.map(function(share, shareIndex) {
    const password = params['password' + shareIndex];
    return self.bitgo.encrypt({
      password: password,
      input: share
    });
  });
  result.seedShares = encryptedShares;
  return result;
};

/**
 * Generate a batch of random BIP32 root keys, from random 256-bit
 * seeds. The seeds are split using Shamir Secret Sharing Scheme
 * (SSSS), such that any M of N of the shares can be recombined to
 * produce the seed. The SSSS shares are encrypted with N separate
 * passwords, intended to be provided at run-time by separate individuals.
 */
BGCL.prototype.handleSplitKeys = function() {
  const self = this;
  const input = new UserInput(this.args);

  const getPassword = function(i, n) {
    if (i === n) {
      return;
    }
    const passwordName = 'password' + i;
    return input.getPassword(passwordName, 'Password for share ' + i + ': ', true)()
    .then(function() {
      return getPassword(i + 1, n);
    });
  };

  return Q().then(function() {
    console.log('Generate Split Keys');
    console.log();
  })
  .then(input.getIntVariable('n', 'Number of shares per key (N): ', true, 1, 10))
  .then(function() {
    let mMin = 2;
    if (input.n === 1) {
      mMin = 1;
    }
    return input.getIntVariable('m', 'Number of shares required to restore key (M <= N): ', true, mMin, input.n)();
  })
  .then(input.getVariable('nkeys', 'Total number of keys to generate: ', true, 1, 100000))
  .then(input.getVariable('prefix', "File prefix [default = 'keys']: ", false, 'keys'))
  .then(input.getVariable('entropy', 'User supplied entropy string (optional): '))
  .then(function() {
    if (input.entropy) {
      self.addUserEntropy(input.entropy);
    }
    return getPassword(0, input.n);
  })
  .then(function() {
    const keys = _.range(0, input.nkeys).map(function(index) {
      const key = self.genSplitKey(input);
      if (index % 10 === 0) {
        console.log('Generating key ' + index);
      }
      return {
        index: index,
        xpub: key.xpub,
        m: key.m,
        n: key.n,
        seedShares: key.seedShares
      };
    });
    let filename = input.prefix + '.json';
    fs.writeFileSync(filename, JSON.stringify(keys, null, 2));
    console.log('Wrote ' + filename);
    const csvRows = keys.map(function(key) {
      return key.index + ',' + key.xpub;
    });
    filename = input.prefix + '.xpub.csv';
    fs.writeFileSync(filename, csvRows.join('\n'));
    console.log('Wrote ' + filename);
  });
};

/**
 * Recover a list of keys from the JSON file produced by splitkeys
 */
BGCL.prototype.handleRecoverKeys = function() {
  const self = this;
  const input = new UserInput(this.args);
  const passwords = [];
  let keysToRecover;

  /**
   * Get a password from the user, testing it against encrypted shares
   * to determine which (if any) index of the shares it corresponds to.
   *
   * @param   {Number} i      index of the password (0..n-1)
   * @param   {Number} n      total number of passwords needed
   * @param   {String[]}   shares   list of encrypted shares
   * @returns {Promise}
   */
  const getPassword = function(i, n, shares) {
    if (i === n) {
      return;
    }
    const passwordName = 'password' + i;
    return input.getPassword(passwordName, 'Password ' + i + ': ', false)()
    .then(function() {
      const password = input[passwordName];
      let found = false;
      shares.forEach(function(share, shareIndex) {
        try {
          sjcl.decrypt(password, share);
          if (!passwords.some(function(p) { return p.shareIndex === shareIndex; })) {
            passwords.push({ shareIndex: shareIndex, password: password });
            found = true;
          }
        } catch (err) {
          console.error(err);
        }
      });
      if (found) {
        return getPassword(i + 1, n, shares);
      }
      console.log('bad password - try again');
      delete input[passwordName];
      return getPassword(i, n, shares);
    });
  };

  return Q().then(function() {
    if (self.args.verifyonly) {
      console.log('Verify Split Keys');
    } else {
      console.log('Recover Keys');
    }

    console.log();
  })
  .then(input.getVariable('file', 'Input file (JSON): '))
  .then(input.getVariable('keys', 'Comma-separated list of key indices to recover: '))
  .then(function() {
    // Grab the list of keys from the file
    const json = fs.readFileSync(input.file);
    const keys = JSON.parse(json);

    // Determine and validate the indices of the keys to recover
    let indices = input.keys.split(',')
      .map(function(x) { return parseInt(x, 10); })
      .filter(function(x) { return !isNaN(x); });
    indices = _.uniq(indices).sort(function(a, b) { return a - b; });
    if (!indices.length) {
      throw new Error('no indices');
    }
    if (indices[0] < 0 || indices[indices.length - 1] >= keys.length) {
      throw new Error('index out of range: ' + keys.length + ' keys in file');
    }

    // Get the keys to recover
    keysToRecover = keys.filter(function(key, index) {
      return indices.indexOf(index) !== -1;
    });

    console.log('Processing ' + keysToRecover.length + ' keys: ' + indices);

    // Get the passwords
    const firstKey = keysToRecover[0];
    return getPassword(0, firstKey.m, firstKey.seedShares);
  })
  .then(function() {
    // For each key we want to recover, decrypt the shares, recombine
    // into a seed, and produce the xprv, validating against existing xpub.
    const recoveredKeys = keysToRecover.map(function(key) {
      const shares = passwords.map(function(p, i) {
        console.log('Decrypting Key #' + key.index + ', Part #' + i);
        return sjcl.decrypt(p.password, key.seedShares[p.shareIndex]);
      });
      let seed;
      if (shares.length === 1) {
        seed = shares[0];
      } else {
        seed = secrets.combine(shares);
      }
      const extendedKey = bitcoin.HDNode.fromSeedHex(seed);
      const xpub = extendedKey.neutered().toBase58();
      const xprv = self.args.verifyonly ? undefined : extendedKey.toBase58();
      if (!self.args.verifyonly && xpub !== key.xpub) {
        throw new Error("xpubs don't match for key " + key.index);
      }
      return {
        index: key.index,
        xpub: xpub,
        xprv: xprv
      };
    });
    self.printJSON(recoveredKeys);
  });
};

/**
 * Dumps a user xprv given a wallet and passphrase
 * @returns {*}
 */
BGCL.prototype.handleDumpWalletUserKey = function() {
  const self = this;
  const input = new UserInput(this.args);

  return self.ensureWallet()
  .then(function() {
    return input.getVariable('password', 'Wallet password: ', true)();
  })
  .then(function() {
    return input.getVariable('confirm', 'Type \'go\' to confirm that you want to dump the wallet private key to output: ')();
  })
  .then(function() {
    if (input.confirm !== 'go') {
      throw new Error('Operation canceled');
    }
    return self.bitgo.wallets().get({ id: self.session.wallet.id() });
  })
  .then(function(wallet) {
    return wallet.getEncryptedUserKeychain();
  })
  .then(function(result) {
    const keychain = result;
    // Decrypt the user key with a passphrase
    try {
      keychain.xprv = self.bitgo.decrypt({ password: input.password, input: keychain.encryptedXprv });
      self.info(keychain.xprv);
    } catch (e) {
      throw new Error('Unable to decrypt user keychain');
    }
  });
};


BGCL.prototype.handleShellCommand = function() {
  const self = this;
  return this.shell.prompt()
  .then(function(line) {
    const args = line.split(' ');
    self.args = self.parser.parseArgs(args);
    return self.runCommandHandler(self.args.cmd);
  })
  .catch(function(err) {
    console.log(err.message);
  })
  .then(function() {
    self.handleShellCommand();
  });
};

BGCL.prototype.runShell = function() {
  if (this.shell) {
    throw new Error('Already in shell');
  }

  // Prevent parseArgs from exiting the process
  this.parser.debug = true;

  process.stdin.resume();
  process.on('SIGINT', function() {
    console.log('caught');
  });

  this.shell = new Shell(this);
  return this.handleShellCommand();
};

BGCL.prototype.handleHelp = function() {
  if (this.args.command) {
    const cmdParser = this.subparsers._nameParserMap[this.args.command];
    if (!cmdParser) {
      console.log('unknown command');
    } else {
      console.log(cmdParser.formatHelp());
    }
    return;
  }
  let help = this.parser.formatHelp();
  // If we're in a shell, just grab the subcommands section
  if (this.shell) {
    let lines = help.split('\n');
    const subcommandsLine = lines.indexOf('subcommands:');
    lines = lines.slice(subcommandsLine + 2);
    help = lines.join('\n');
  }
  console.log(help);
};

BGCL.prototype.modifyAuthError = function(err) {
  if (err.status === 401 && !err.needsOTP) {
    err.message = 'Not logged in';
  }
  return err;
};

BGCL.prototype.ensureWallet = function() {
  const self = this;
  return this.ensureAuthenticated()
  .then(function() {
    if (!self.session.wallet) {
      throw new Error('No current wallet.');
    }
  });
};

BGCL.prototype.ensureAuthenticated = function() {
  return this.bitgo.me()
  .catch(function(err) {
    throw new Error('Not logged in');
  });
};

function printWebhookList(webhooks) {
  const rows = webhooks.map(function(w) {
    return ' ' +
      _.string.rpad(w.type, 15) +
      _.string.pad(w.numConfirmations, 18, ' ') +
      '  ' + w.url;
  });
  console.log(' ' +
              _.string.rpad('Type', 15) +
              _.string.pad('NumConfirmations', 18) +
              '  URL'
  );
  console.log(rows.join('\n'));
}

BGCL.prototype.handleListWebhooks = function() {
  const wallet = this.session.wallet;

  if (!wallet) {
    throw new Error('No current wallet.');
  }
  this.walletHeader();
  console.log('\nWebhooks:');
  wallet.listWebhooks({})
  .then(function(webhooks) {
    printWebhookList(webhooks.webhooks);
  })
  .catch(function(err) {
    console.error(err);
  });

};

BGCL.prototype.handleAddWebhook = function() {
  const wallet = this.session.wallet;
  const input = new UserInput(this.args);

  if (!wallet) {
    throw new Error('No current wallet.');
  }
  this.walletHeader();

  wallet.addWebhook({
    url: input.url,
    type: input.type,
    numConfirmations: input.numConfirmations
  })
  .then(function(result) {
    printWebhookList([result]);
  })
  .catch(function(err) {
    console.error(err);
  });
};

BGCL.prototype.handleRemoveWebhook = function() {
  const wallet = this.session.wallet;
  const input = new UserInput(this.args);

  if (!wallet) {
    throw new Error('No current wallet.');
  }
  this.walletHeader();

  wallet.removeWebhook({
    url: input.url,
    type: input.type
  })
  .then(function(result) {
    console.dir(result);
  })
  .catch(function(err) {
    console.error(err);
  });
};

BGCL.prototype.handleRecoverBCHFromSafeHD = co(function *() {
  const input = new UserInput(this.args);
  // ensure a wallet is selected
  yield this.ensureWallet();
  yield input.getVariable('dest', 'Destination address: ')();
  const destinationAddress = input.dest;
  try {
    bitcoin.address.fromBase58Check(destinationAddress);
  } catch (e) {
    throw new Error('Invalid destination address');
  }

  const bch = this.bitgo.coin('bch');
  const bchWallets = yield bch.wallets().list();
  const migratedWallet = _.find(bchWallets.wallets, w => w._wallet.migratedFrom === this.session.wallet.id());

  const feeToPay = 0.005 * 1e8;
  const amount = Math.floor(migratedWallet.spendableBalance() * 0.999) - feeToPay;
  const txPrebuild = yield migratedWallet.prebuildTransaction({
    recipients: [{
      address: destinationAddress,
      amount: amount
    }]
  });

  yield input.getVariable('password', 'Wallet password: ')();
  const signingKeychain = yield this.session.wallet.getAndPrepareSigningKeychain({ walletPassphrase: input.password });
  const rootExtKey = bitcoin.HDNode.fromBase58(signingKeychain.xprv);
  const hdPath = bitcoin.hdPath(rootExtKey);

  // sign the transaction
  let transaction = bitcoin.Transaction.fromHex(txPrebuild.txHex);

  if (transaction.ins.length !== txPrebuild.txInfo.unspents.length) {
    throw new Error('length of unspents array should equal to the number of transaction inputs');
  }

  const txb = bitcoin.TransactionBuilder.fromTransaction(transaction);
  txb.enableBitcoinCash(true);
  txb.setVersion(2);


  const sigHashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
  for (let inputIndex = 0; inputIndex < transaction.ins.length; ++inputIndex) {
    // get the current unspent
    const currentUnspent = txPrebuild.txInfo.unspents[inputIndex];
    const chainPath = '/' + currentUnspent.chain + '/' + currentUnspent.index;
    const subPath = signingKeychain.walletSubPath || '/0/0';
    const path = signingKeychain.path + subPath + chainPath;
    // derive the correct key
    const privKey = hdPath.deriveKey(path);
    const value = currentUnspent.value;

    // do the signature flow
    const subscript = new Buffer(currentUnspent.redeemScript, 'hex');
    try {
      txb.sign(inputIndex, privKey, subscript, sigHashType, value);
      // gotta keep updating
      transaction = txb.buildIncomplete();
    } catch (e) {
      e.result = {
        unspent: currentUnspent
      };
      e.message = `${e.message} — ${JSON.stringify(e.result, null, 4)}`;
      console.trace(e);
      throw new Error('Failed to sign input #' + inputIndex);
    }

    // now, let's verify the signature
    const isSignatureVerified = bch.verifySignature(transaction, inputIndex, value);
    if (!isSignatureVerified) {
      throw new Error(`Could not verify signature #${inputIndex}`);
    }
  }

  const halfSignedTx = txb.buildIncomplete().toHex();
  this.info('Half-signed transaction: ' + halfSignedTx);

  yield this.handleUnlock();

  const sendUrl = migratedWallet.url('/tx/send');
  const fullySignedTx = yield this.bitgo.post(sendUrl)
  .send({
    txHex: halfSignedTx
  })
  .result();
  this.info('Signed Transaction: ' + JSON.stringify(fullySignedTx, null, 4));
});

BGCL.prototype.handleRecoverBTGFromSafeHD = co(function *() {
  const input = new UserInput(this.args);
  // ensure a wallet is selected
  yield this.ensureWallet();
  yield input.getVariable('dest', 'Destination address: ')();
  const destinationAddress = input.dest;
  try {
    bitcoin.address.fromBase58Check(destinationAddress);
  } catch (e) {
    throw new Error('Invalid destination address');
  }

  const btg = this.bitgo.coin('btg');
  const btgWallets = yield btg.wallets().list();
  const migratedWallet = _.find(btgWallets.wallets, w => w._wallet.migratedFrom === this.session.wallet.id());

  const feeToPay = 0.005 * 1e8;
  const amount = Math.floor(migratedWallet.spendableBalance() * 0.999) - feeToPay; // we can't spend everything, but it's just $25
  const txPrebuild = yield migratedWallet.prebuildTransaction({
    recipients: [{
      address: destinationAddress,
      amount: amount
    }]
  });

  yield input.getVariable('password', 'Wallet password: ')();
  const signingKeychain = yield this.session.wallet.getAndPrepareSigningKeychain({ walletPassphrase: input.password });
  const rootExtKey = bitcoin.HDNode.fromBase58(signingKeychain.xprv);
  const hdPath = bitcoin.hdPath(rootExtKey);

  // sign the transaction
  let transaction = bitcoin.Transaction.fromHex(txPrebuild.txHex);

  if (transaction.ins.length !== txPrebuild.txInfo.unspents.length) {
    throw new Error('length of unspents array should equal to the number of transaction inputs');
  }

  const txb = bitcoin.TransactionBuilder.fromTransaction(transaction);
  txb.enableBitcoinGold(true);
  txb.setVersion(2);


  const sigHashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
  for (let inputIndex = 0; inputIndex < transaction.ins.length; ++inputIndex) {
    // get the current unspent
    const currentUnspent = txPrebuild.txInfo.unspents[inputIndex];
    const chainPath = '/' + currentUnspent.chain + '/' + currentUnspent.index;
    const subPath = signingKeychain.walletSubPath || '/0/0';
    const path = signingKeychain.path + subPath + chainPath;
    // derive the correct key
    const privKey = hdPath.deriveKey(path);
    const value = currentUnspent.value;

    // do the signature flow
    const subscript = new Buffer(currentUnspent.redeemScript, 'hex');
    const isSegwit = !!currentUnspent.witnessScript;

    let witnessScript;
    if (isSegwit) {
      witnessScript = Buffer.from(currentUnspent.witnessScript, 'hex');
    }

    try {
      txb.sign(inputIndex, privKey, subscript, sigHashType, value, witnessScript);
      // gotta keep updating
      transaction = txb.buildIncomplete();
    } catch (e) {
      e.result = {
        unspent: currentUnspent
      };
      e.message = `${e.message} — ${JSON.stringify(e.result, null, 4)}`;
      console.trace(e);
      throw new Error('Failed to sign input #' + inputIndex);
    }

    // now, let's verify the signature
    const isSignatureVerified = btg.verifySignature(transaction, inputIndex, value);
    if (!isSignatureVerified) {
      throw new Error(`Could not verify signature #${inputIndex}`);
    }
  }

  const halfSignedTx = txb.buildIncomplete().toHex();
  this.info('Half-signed transaction: ' + halfSignedTx);

  yield this.handleUnlock();

  const sendUrl = migratedWallet.url('/tx/send');
  const fullySignedTx = yield this.bitgo.post(sendUrl)
  .send({
    txHex: halfSignedTx
  })
  .result();
  this.info('Signed Transaction: ' + JSON.stringify(fullySignedTx, null, 4));
});

/**
 * Aids in the recovery of BCH that was sent to a Bitcoin (non-SegWit) address
 * It creates a half signed transaction using the users private keys and
 * then needs to be signed by BitGo for the transaction to be complete.
 *
 * The user must initially input the faulty tx id and a destination address for recovery.
 * This build and apply a signature to a recovery transaction, which can then be submitted
 * to BitGo for cosigning and broadcasting.
 */
BGCL.prototype.handleRecoverBCHFromBTCNonSegWit = co(function *() {
  const printSeparator = () => { this.info(_.repeat('=', 80)); };

  // Find unspents on BCH Chain
  const input = new UserInput(this.args);

  this.info('This tool will help you construct a transaction to recover BCH mistakenly sent to a non-SegWit BTC address.');

  printSeparator();

  yield input.getVariable('sourceWallet', 'Please enter the wallet ID the faulty transaction originated from: ', true)();
  // Right now, we need this, but once we have getWalletByAddress we can remove this
  yield input.getVariable('recoveryWallet', 'Please enter the wallet ID of the BTC wallet that received the funds: ', true)();
  yield input.getVariable('txid', 'Please enter the transaction ID of your faulty transaction: ', true)();
  yield input.getVariable('recoveryAddress', 'Please enter the address you wish to recover your BCH to: ', true)();

  printSeparator();

  const { txid, recoveryAddress, sourceWallet, recoveryWallet } = input;

  const recoveryTool = new RecoveryTool({
    bitgo: this.bitgo,
    sourceCoin: 'bch',
    recoveryType: 'btc',
    test: !!this.args.test,
    logger: this.info
  });

  yield recoveryTool.buildTransaction({
    sourceWallet: sourceWallet,
    recoveryWallet: recoveryWallet,
    faultyTxId: txid,
    recoveryAddress: recoveryAddress
  });

  // get prv and sign transaction
  yield input.getPassword('passphrase', 'Please enter your wallet passphrase (leave blank if you know the private key): ')();

  if (!input.passphrase) {
    yield input.getPassword('prv', 'Please enter your private key: ', true)();
  }

  yield recoveryTool.signTransaction({
    passphrase: input.passphrase,
    prv: input.prv
  });

  recoveryTool.saveToFile();
});

/**
 * Aids in the recovery of BTC that was sent to a Bitcoin Cash address
 * It creates a half signed transaction using the users private keys and
 * then needs to be signed by BitGo for the transaction to be complete.
 *
 * The user must initially input the faulty tx id and a destination address for recovery.
 * This build and apply a signature to a recovery transaction, which can then be submitted
 * to BitGo for cosigning and broadcasting.
 */
BGCL.prototype.handleRecoverBTCFromBCH = co(function *() {
  const printSeparator = () => { this.info(_.repeat('=', 80)); };

  // Find unspents on BCH Chain
  const input = new UserInput(this.args);

  this.info('This tool will help you construct a transaction to recover BTC mistakenly sent to a BCH address.');

  printSeparator();

  yield input.getVariable('sourceWallet', 'Please enter the wallet ID the faulty transaction originated from: ', true)();
  // Right now, we need this, but once we have getWalletByAddress we can remove this
  yield input.getVariable('recoveryWallet', 'Please enter the wallet ID of the BTC wallet that received the funds: ', true)();
  yield input.getVariable('txid', 'Please enter the transaction ID of your faulty transaction: ', true)();
  yield input.getVariable('recoveryAddress', 'Please enter the address you wish to recover your BCH to: ', true)();

  printSeparator();

  const { txid, recoveryAddress, sourceWallet, recoveryWallet } = input;

  const recoveryTool = new RecoveryTool({
    bitgo: this.bitgo,
    sourceCoin: 'btc',
    recoveryType: 'bch',
    test: !!this.args.test,
    logger: this.info
  });

  yield recoveryTool.buildTransaction({
    sourceWallet: sourceWallet,
    recoveryWallet: recoveryWallet,
    faultyTxId: txid,
    recoveryAddress: recoveryAddress
  });

  // get prv and sign transaction
  yield input.getPassword('passphrase', 'Please enter your wallet passphrase (leave blank if you know the private key): ')();

  if (!input.passphrase) {
    yield input.getPassword('prv', 'Please enter your private key: ')();
  }

  yield recoveryTool.signTransaction({
    passphrase: input.passphrase,
    prv: input.prv
  });

  recoveryTool.saveToFile();
});

/**
 * Aids in the recovery of Litecoin that was sent to a BitCoin address
 * It creates a half signed transaction using the users private keys and
 * then needs to be signed by BitGo for the transaction to be complete.
 * This function only works on Litecoin mainnet.
 */
BGCL.prototype.handleRecoverLitecoin = co(function *() {
  const printSeparator = () => { this.info(_.repeat('=', 80)); };

  // Find unspents on BCH Chain
  const input = new UserInput(this.args);

  this.info('This tool will help you construct a transaction to recover LTC mistakenly sent to a BTC address.');

  printSeparator();

  yield input.getVariable('sourceWallet', 'Please enter the wallet ID the faulty transaction originated from: ', true)();
  // Right now, we need this, but once we have getWalletByAddress we can remove this
  yield input.getVariable('recoveryWallet', 'Please enter the wallet ID of the BTC wallet that received the funds: ', true)();
  yield input.getVariable('txid', 'Please enter the transaction ID of your faulty transaction: ', true)();
  yield input.getVariable('recoveryAddress', 'Please enter the address you wish to recover your BCH to: ', true)();

  printSeparator();

  const { txid, recoveryAddress, sourceWallet, recoveryWallet } = input;

  const recoveryTool = new RecoveryTool({
    bitgo: this.bitgo,
    sourceCoin: 'ltc',
    recoveryType: 'btc',
    test: !!this.args.test,
    logger: this.info
  });

  yield recoveryTool.buildTransaction({
    sourceWallet: sourceWallet,
    recoveryWallet: recoveryWallet,
    faultyTxId: txid,
    recoveryAddress: recoveryAddress
  });

  // get prv and sign transaction
  yield input.getPassword('passphrase', 'Please enter your wallet passphrase (leave blank if you know the private key): ')();

  if (!input.passphrase) {
    yield input.getPassword('prv', 'Please enter your private key: ')();
  }

  yield recoveryTool.signTransaction({
    passphrase: input.passphrase,
    prv: input.prv
  });

  recoveryTool.saveToFile();
});

BGCL.prototype.runCommandHandler = function(cmd) {
  const self = this;

  switch (cmd) {
    case 'login':
      return this.handleLogin();
    case 'logout':
      return this.handleLogout();
    case 'status':
      return this.handleStatus();
    case 'otp':
      return this.handleOTP();
    case 'wallets':
      return this.handleWallets();
    case 'wallet':
      if (this.args.wallet) {
        return this.handleWallets(this.args.wallet)
        .then(function() {
          console.log();
          return self.handleWallet();
        });
      }
      return this.handleWallet();
    case 'balance':
      return this.handleBalance();
    case 'labels':
      return this.handleLabels();
    case 'setlabel':
      return this.handleSetLabel();
    case 'removelabel':
      return this.handleRemoveLabel();
    case 'addresses':
      return this.handleAddresses();
    case 'newaddress':
      return this.handleNewAddress();
    case 'tx':
      return this.handleTxList();
    case 'unlock':
      return this.handleUnlock();
    case 'lock':
      return this.handleLock();
    case 'sharewallet':
      return this.handleShareWallet();
    case 'shares':
      return this.handleShares();
    case 'acceptshare':
      return this.handleAcceptShare();
    case 'cancelshare':
      return this.handleCancelShare();
    case 'freezewallet':
      return this.handleFreezeWallet();
    case 'removewallet':
      return this.handleRemoveWallet();
    case 'unspents':
    case 'unspent':
      return this.handleUnspents();
    case 'consolidate':
      return this.handleConsolidateUnspents();
    case 'fanout':
      return this.handleFanoutUnspents();
    case 'sendtoaddress':
      return this.handleSendToAddress();
    case 'newkey':
      return this.handleNewKey();
    case 'encryptkey':
      return this.handleEncryptKey();
    case 'splitkeys':
      return this.handleSplitKeys();
    case 'verifysplitkeys':
      this.args.verifyonly = true;
      return this.handleRecoverKeys();
    case 'recoverkeys':
      return this.handleRecoverKeys();
    case 'dumpwalletuserkey':
      return this.handleDumpWalletUserKey();
    case 'newwallet':
      return this.handleNewWallet();
    case 'token':
      return this.handleToken();
    case 'shell':
      return this.runShell();
    case 'help':
      return this.handleHelp();
    case 'createtx':
      return this.handleCreateTx();
    case 'signtx':
      return this.handleSignTx();
    case 'sendtx':
      return this.handleSendTx();
    case 'listWebhooks':
      return this.handleListWebhooks();
    case 'addWebhook':
      return this.handleAddWebhook();
    case 'removeWebhook':
      return this.handleRemoveWebhook();
    case 'util':
      return this.handleUtil();
    default:
      throw new Error('unknown command');
  }
};

BGCL.prototype.run = function() {
  this.parser = this.createArgumentParser();
  this.args = this.parser.parseArgs();

  // Setup BitGo for chosen environment
  const env = this.args.env || process.env.BITGO_ENV || 'prod';
  const userAgent = 'BitGoCLI/' + CLI_VERSION;
  this.bitgo = new bitgo.BitGo({ env: env, userAgent: userAgent });
  this.env = env;

  this.session = new Session(this.bitgo);
  this.session.load();

  const self = this;
  Q().then(function() {
    // console.error();
    return self.runCommandHandler(self.args.cmd);
  })
  .catch(function(err) {
    self.modifyAuthError(err);
    console.error(err.message || err);
    // console.error();
    console.error(err.stack);
    process.exit(1);
  })
  .done();
};

exports = module.exports = {
  BGCL: BGCL,
  UserInput: UserInput,
  Session: Session
};
