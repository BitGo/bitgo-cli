#!/usr/bin/env node

var ArgumentParser = require('argparse').ArgumentParser;
var bitgo = require('bitgo');
var Crypto = require('crypto');
var Q = require('q');
var fs = require('fs');
var moment = require('moment');
var read = require('read');
var readline = require('readline');
var _ = require('lodash');
_.string = require('underscore.string');

//Q.longStackSupport = true;

function getUserHome() {
  return process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
}

var BITGO_DIR = getUserHome() + '/.bitgo';

function filename(name) {
  return BITGO_DIR + '/' + name + '.json';
}

function loadJSON(name) {
  try {
    data = fs.readFileSync(filename(name), {encoding: 'utf8'});
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
  fs.writeFileSync(filename(name), data, {encoding: 'utf8', mode: 0600});
}

var UserInput = function(args) {
  _.assign(this, args);
};

// Prompt the user for input
UserInput.prototype.prompt = function(question, required) {
  var answer = "";
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  var deferred = Q.defer();
  rl.setPrompt(question);
  rl.prompt();
  rl.on('line', function(line) {
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
UserInput.prototype.promptPassword = function(question) {
  var answer = "";
  var deferred = Q.defer();
  read({prompt: question, silent:true, replace: '*'}, function(err, result) {
    if (err) {
      deferred.reject(err);
    } else {
      deferred.resolve(result);
    }
  });
  return deferred.promise;
};

// Get input from user into variable, with question as prompt
UserInput.prototype.getVariable = function(variable, question, required) {
  var self = this;
  return function() {
    return Q().then(function() {
      if (self[variable]) {
        return;
      }
      return Q().then(function() {
        if (variable == 'password' || variable == 'passcode') {
          return self.promptPassword(question);
        } else {
          return self.prompt(question, required);
        }
      })
      .then(function(value) {
        self[variable] = value;
      });
    });
  };
};

UserInput.prototype.getPassword = function(variable, question) {
  var self = this;
  return function() {
    if (self[variable]) {
      return Q();
    }

    return self.prompt(question, required)
    .then(function(value) {
      self[variable] = value;
    });
  };
};



var Session = function(bitgo) {
  this.bitgo = bitgo;
  this.currentWallet = undefined;
  this.wallets = {};
  this.labels = {};
};

Session.prototype.load = function() {
  var session = loadJSON(bitgo.network);
  if (session) {
    if (session.bitgo) {
      this.bitgo.fromJSON(session.bitgo);
    }
    this.currentWallet = session.currentWallet;
    this.wallets = session.wallets;
    this.labels = session.labels;
  }
};

Session.prototype.save = function() {
  saveJSON(bitgo.network, this);
};

// Session.prototype.toJSON = function() {
//   return {
//     bitgo: this.bitgo,
//     currentWallet: this.currentWallet,
//     wallets: this.wallets,
//     labels: this.labels
//   };
// };

Session.prototype.labelForWallet = function(walletId) {
  return this.wallets && this.wallets[walletId] && this.wallets[walletId].label;
};

Session.prototype.labelForAddress = function(address) {
  var labels = this.labels && this.labels[address];
  if (!labels || labels.length === 0) {
    return undefined;
  }
  if (labels.length === 1) {
    return labels[0].label;
  }
  var foundLabel;
  labels.forEach(function(label) {
    if (label.walletId === this.currentWallet) {
      foundLabel = label.label;
      return false; // break out
    }
  });
  if (foundLabel) { return foundLabel; }
  return labels[0].label; // found multiple, return first one
};

var BGCL = function() {
};

BGCL.prototype.getArgs = function() {
  var parser = new ArgumentParser({
    version: '0.1',
    addHelp:true,
    description: 'BitGo Command-Line'
  });
  parser.addArgument(
    ['-t', '--testnet'], {
    action: 'storeConst',
    constant: 1,
    help: 'Use BitGo testnet environment (test.bitgo.com)'
  });

  var subparsers = parser.addSubparsers({
    title:'subcommands',
    dest:"cmd"
  });

  // login
  var login = subparsers.addParser('login', {
    addHelp: true,
    help: 'Sign in to BitGo'
  });
  login.addArgument(['-u', '--username'], {help: 'the account email'});
  login.addArgument(['-p', '--password'], {help: 'the account password'});
  login.addArgument(['-o', '--otp'], {help: 'the 2-step verification code'});

  // logout
  var logout = subparsers.addParser('logout', {
    addHelp: true,
    help: 'Sign out of BitGo'
  });

  // token
  var token = subparsers.addParser('token', {
    addHelp: true,
    help: 'Authenticate with BitGo with a token'
  });

  // // token
  // var token = subparsers.addParser('token', {
  //   addHelp: true,
  //   help: 'Show current auth token'
  // });

  // status
  var status = subparsers.addParser('status', {
    addHelp: true,
    help: 'Show current status'
  });

  // wallets
  var wallets = subparsers.addParser('wallets', {
    addHelp: true,
    help: 'Get list of available wallets'
  });

  // wallet
  var wallet = subparsers.addParser('wallet', {
    addHelp: true,
    help: 'Set or get the current wallet'
  });
  wallet.addArgument(['wallet'], {nargs: '?', help: 'the index, id, or name of the wallet to set as current'});

  // addresses
  var addresses = subparsers.addParser('addresses', {
    addHelp: true,
    help: 'List addresses for the current wallet'
  });
  addresses.addArgument(['-c', '--change'], {action: 'storeConst', constant: 1, help: 'include change addresses'});

  // newaddress
  var newAddress = subparsers.addParser('newaddress', {
    addHelp: true,
    help: 'Create a new receive address for the current wallet'
  });

  // txlist
  var txList = subparsers.addParser('tx', {
    addHelp: true,
    help: 'List transactions on the current wallet'
  });

  // unlock
  var unlock = subparsers.addParser('unlock', {
    addHelp: true,
    help: 'Unlock the session to allow transacting'
  });
  unlock.addArgument(['-o', '--otp'], {help: 'the 2-step verification code'});

  // lock
  var lock = subparsers.addParser('lock', {
    addHelp: true,
    help: 'Re-lock the session'
  });

  // send
  var spend = subparsers.addParser('send', {
    aliases: ['spend'],
    addHelp: true,
    help: 'Create and send a transaction'
  });
  spend.addArgument(['-d', '--dest'], {help: 'the destination address'});
  spend.addArgument(['-a', '--amount'], {help: 'the amount in BTC'});
  spend.addArgument(['-p', '--passcode'], {help: 'the wallet passcode'});
  spend.addArgument(['-o', '--otp'], {help: 'the 2-step verification code'});
  spend.addArgument(['-c', '--comment'], {help: 'optional comment'});
  spend.addArgument(['--confirm'], {action: 'storeConst', constant: 'go', help: 'skip interactive confirm step -- be careful!'});

  // newkey
  var newKey = subparsers.addParser('newkey', {
    addHelp: true,
    help: 'Create a new BIP32 keychain (client-side only)'
  });
  newKey.addArgument(['entropy'], {nargs: '?', help: 'optional additional entropy'});

  // newwallet
  var newWallet = subparsers.addParser('newwallet', {
    addHelp: true,
    help: 'Create a new Multi-Sig HD wallet'
  });
  newWallet.addArgument(['-n', '--name'], {help: 'name for the wallet'});
  newWallet.addArgument(['-u', '--userkey'], {help: 'xprv for the user keychain'});
  newWallet.addArgument(['-b', '--backupkey'], {help: 'xpub for the backup keychain'});

  return parser.parseArgs();
};

BGCL.prototype.toBTC = function(satoshis, decimals) {
  if (satoshis === 0) {
    return '0';
  }
  if (typeof(decimals) == 'undefined') {
    decimals = 4;
  }
  return (satoshis * 1e-8).toFixed(decimals);
};

BGCL.prototype.inBrackets = function(str) {
  return '[' + str + ']';
};

BGCL.prototype.info = function(line) {
  console.log(line);
};

BGCL.prototype.action = function(line) {
  console.log('*** ' + line);
  console.log();
};

BGCL.prototype.header = function(line) {
  return line; // '> ' + line; // + ' ]';
};

BGCL.prototype.userHeader = function() {
  var user = this.bitgo.user();
  var username = user ? user.username : 'None';
  this.info('Current User: ' + username);
};

BGCL.prototype.walletHeader = function() {
  console.log('Current wallet: ' + this.session.currentWallet);
};

BGCL.prototype.formatWalletId = function(walletId) {
  var label = this.session.labelForWallet(walletId);
  if (label) {
    return _.string.truncate(label, 22);
  }
  var shortened = _.string.truncate(walletId, 12);
  return this.inBrackets('Wallet: ' + shortened);
};

BGCL.prototype.fetchLabels = function() {
  // TODO: add labels fetch to SDK
  var self = this;
  return this.bitgo.get(this.bitgo.url('/labels')).result('labels')
  .then(function(labels) {
    self.session.labels = _.groupBy(labels, 'address');
    self.session.save();
    return labels;
  });
};

BGCL.prototype.handleToken = function() {
  var self = this;
  self.bitgo.clear();
  var input = new UserInput(this.args);
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
    var promises = [];
    promises.push(self.handleWallets());
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
  var self = this;
  self.bitgo.clear();
  var input = new UserInput(this.args);
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
    var promises = [];
    promises.push(self.handleWallets());
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
  return this.bitgo.logout()
  .then(function() {
    this.action('Logged out');
  });
};

// BGCL.prototype.handleToken = function() {
//   var self = this;
//   return self.ensureAuthenticated()
//   .then(function() {
//     self.info(self.bitgo._token);
//   });
// };

BGCL.prototype.handleStatus = function() {
  this.info('Network: ' + bitgo.network);
  this.info('Session file: ' + filename(bitgo.network));
  this.userHeader();
  var self = this;
  return self.ensureAuthenticated()
  .then(function() {
    self.info('Logged in');
    self.walletHeader();
  });
};

BGCL.prototype.printWalletList = function(wallets) {
  var self = this;
  // console.log(this.userHeader());
  // console.log();
  this.info('Wallets:');
  var width = (wallets.length - 1).toString().length;
  var rows = wallets.map(function(w, index) {
    var balance = self.toBTC(w.balance());
    balance = _.string.pad(balance, 10) + ' BTC';

    var marker = self.session.currentWallet == w.id() ? '>> ' : '   ';
    return marker + _.string.pad(index, width) + '  ' + w.id() + '  ' + balance + '  ' + _.string.truncate(w.label(), 20);
  });
  console.log(rows.join('\n'));
};

BGCL.prototype.handleWallets = function(setWallet) {
  var self = this;

  // Pre-process setWallet, if provided, to determine what type it is. It
  // may be a wallet id, an index, or a wallet name.
  var setWalletType;
  if (setWallet) {
    try {
      new bitgo.Address(setWallet);
      setWalletType = 'id';
    } catch (e) {
      var walletIndex = parseInt(setWallet);
      if (walletIndex == setWallet) {
        setWalletType = 'index';
        setWallet = walletIndex;
      } else {
        setWalletType = 'name';
      }
    }
  }

  var findWallet = function(w, index) {
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
  .then(function(wallets) {
    // Save wallets map to session
    var sessionWallets = {};
    _.keys(wallets).forEach(function(id) {
      sessionWallets[id] = _.pick(wallets[id].wallet, ['id', 'label']);
    });
    self.session.wallets = sessionWallets;
    self.session.save();

    var walletIds = _.keys(wallets);
    var fetches = walletIds.map(function(id) { return self.bitgo.wallets().get({ id: id }); });
    return Q.all(fetches);
  })
  .then(function(wallets) {
    var sortedWallets = _.sortBy(wallets, function(w) { return w.label() + w.id(); });

    // Find new current wallet id to set, based on setWallet param or default to index 0 if no current wallet
    var newCurrentWallet;
    if (setWalletType) {
      var wallet = _.find(sortedWallets, findWallet);
      if (!wallet) {
        throw new Error('Wallet ' + setWallet + ' not found');
      }
      newCurrentWallet = wallet.id();
      self.action('Set current wallet to ' + newCurrentWallet);
    } else if (!self.session.currentWallet && sortedWallets.length) {
      newCurrentWallet = sortedWallets[0].id();
    }
    if (newCurrentWallet) {
      self.session.currentWallet = newCurrentWallet;
      self.session.save();
    }

    if (sortedWallets.length) {
      self.printWalletList(sortedWallets);
      self.info('\nCurrent wallet marked with >>. Use the wallet cmd to change.');
    } else {
      console.log ('No wallets. Use the newwallet command to create one.');
    }
    return sortedWallets;
  });
};

BGCL.prototype.handleWallet = function() {
  if (!this.session.currentWallet) {
    throw new Error('No current wallet set. Use the setwallet command to set one.');
  }

  var self = this;
  var wallet;
  return this.bitgo.wallets().get({id: this.session.currentWallet})
  .then(function(result) {
    wallet = result;
    return wallet.createAddress({allowExisting: '1'});
  })
  .then(function(address) {
    var unconfirmed = (wallet.balance() !== wallet.confirmedBalance()) ? '  [ ** includes unconfirmed ]' : '';
    self.info('Current Wallet:');
    self.info('  Name:         ' + wallet.label());
    self.info('  ID:           ' + wallet.id());
    self.info('  Balance:      ' + self.toBTC(wallet.balance(), 8) + ' BTC' + unconfirmed);
    if (unconfirmed) {
      self.info('  Confirmed:    ' + self.toBTC(wallet.confirmedBalance(), 8) + ' BTC');
    }
    self.info('  Recv address: ' + address.address + ' ' + self.inBrackets(address.index) );
  });
};

BGCL.prototype.handleAddresses = function() {
  var printAddressList = function(addresses) {
    var rows = addresses.map(function(a) {
      var balance = self.toBTC(a.balance);
      var received = self.toBTC(a.received);
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

  var self = this;
  if (!this.session.currentWallet) {
    throw new Error('No current wallet.');
  }
  var wallet = this.bitgo.newWalletObject(this.session.currentWallet);
  var queries = [];
  queries.push(wallet.addresses({chain: 0, limit: 200, details: '1'}));
  if (this.args.change) {
    queries.push(wallet.addresses({chain: 1, limit: 200, details: '1'}));
  }
  this.walletHeader();
  return Q.spread(queries, function(receiveAddresses, changeAddresses) {
    self.info('\nReceive Addresses:');
    printAddressList(receiveAddresses.addresses);
    if (changeAddresses) {
      self.info('\nChange Addresses:');
      printAddressList(changeAddresses.addresses);
    }
//    console.dir(addresses);
  });
};

BGCL.prototype.handleNewAddress = function() {
  var self = this;
  if (!this.session.currentWallet) {
    throw new Error('No current wallet.');
  }
  var wallet = this.bitgo.newWalletObject(this.session.currentWallet);
  return wallet.createAddress()
  .then(function(address) {
    self.action('Created new receive address: ' + address.address);
    return self.handleWallet();
  });
};

BGCL.prototype.handleTxList = function() {
  var printTxList = function(txlist) {
    var rows = txlist.map(function(tx) {
      var txid = tx.transactionId.substr(0,8);
      var date = new moment(tx.date).format('YYYY-MM-DD HH:mm');
      var inout = tx.amount > 0 ? 'recv' : 'send';
      var prep = tx.amount > 0 ? 'on' : 'to';
      if (tx.otherWalletId) {
        inout = 'xfer';
        prep = tx.amount > 0 ? 'from' : 'to';
      }
      var amount = self.toBTC(tx.amount);
      if (tx.amount > 0) {
        amount = '+' + amount;
      }
      var pending = tx.state == 'unconfirmed' ? '* ' : '  ';
      var target = '';
      if (tx.otherWalletId) {
        if (tx.otherWalletId === tx.walletId) {
          target = 'self';
        } else {
          target = self.formatWalletId(tx.otherWalletId);
//          target = self.inBrackets('Wallet: ' + _.string.truncate(tx.otherWalletId, 12));
        }
      } else if (tx.toAddress) {
        target = self.session.labelForAddress(tx.toAddress) || tx.toAddress;
      }
      if (!target) {
        prep = '       ';
      } else {
        prep = inout + ' ' + prep;
      }
      var row = pending + date + '  '  +
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
      _.string.lpad('Amt', 10) + '  ' +
      _.string.rpad('Description', 42)
    );
    console.log();
    console.log(rows.join('\n'));
  };

  var self = this;
  if (!this.session.currentWallet) {
    throw new Error('No current wallet.');
  }
  var wallet = this.bitgo.newWalletObject(this.session.currentWallet);

  return this.bitgo.get(wallet.url('/wallettx')).result()
  .then(function(result) {
    self.walletHeader();
    printTxList(result.transactions);
  });
};

BGCL.prototype.handleUnlock = function() {
  var self = this;
  var input = new UserInput(this.args);
  return Q()
  .then(function() {
    if (!input.otp) {
      // this triggers a push
      return self.bitgo.sendOTP();
    }
  })
  .then(input.getVariable('otp', '2-step Verification Code: '))
  .then(function() {
    return self.bitgo.unlock({'otp': input.otp});
  })
  .then(function() {
    self.action('Unlocked session');
  });
};

BGCL.prototype.handleLock = function() {
  var self = this;
  var input = new UserInput(this.args);
  return self.bitgo.lock()
  .then(function() {
    self.action('Locked session');
  });
};

BGCL.prototype.handleSend = function() {
  var self = this;
  var input = new UserInput(this.args);
  var satoshis;

  return this.ensureAuthenticated()
  .then(function() {
    if (!self.session.currentWallet) {
      throw new Error('No current wallet.');
    }
    self.walletHeader();
    console.log();
    self.info('Send Transaction:\n');
  })
  .then(input.getVariable('dest', 'Destination address: '))
  .then(input.getVariable('amount', 'Amount (in BTC): '))
  .then(input.getVariable('passcode', 'Wallet passcode: '))
  .then(input.getVariable('comment', 'Optional comment: '))
  .then(function() {
    input.comment = input.comment || undefined;
    try {
      new bitgo.Address(input.dest);
    } catch (e) {
      throw new Error('Invalid destination address');
    }
    satoshis = Math.floor(Number(input.amount) * 1e8);
    if (isNaN(satoshis)) {
      throw new Error('Invalid amount (non-numeric)');
    }
    var prefix = input.confirm ? 'Sending' : 'Please confirm sending';
    self.info(prefix + ' BTC ' + self.toBTC(satoshis) + ' + 0.0001 blockchain fee to ' + input.dest + '\n');
    return input.getVariable('confirm', 'Type \'go\' to confirm: ')();
  })
  .then(function() {
    if (input.confirm !== 'go') {
      throw new Error('Transaction canceled');
    }
    return self.bitgo.wallets().get({ id: self.session.currentWallet });
  })
  .then(function(wallet) {
    var satoshis = Math.floor(input.amount * 1e8);
    var txParams = {
      address: input.dest,
      amount: satoshis,
      walletPassphrase: input.passcode,
      message: input.comment
    };
    return wallet.sendCoins(txParams)
    .catch(function(err) {
      if (err.needsOTP) {
        // unlock
        return self.handleUnlock()
        .then(function() {
          // try again
          return wallet.sendCoins(txParams);
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

BGCL.prototype.handleNewKey = function() {
  var randomBytes = new Array(256/8); // 256-bit entropy
  new bitgo.SecureRandom().nextBytes(randomBytes);
  var seed = bitgo.Util.bytesToHex(randomBytes);
  var key = new bitgo.BIP32().initFromSeed(seed);
  this.action('Created new BIP32 keychain');
  this.info('Seed:  ' + seed);
  this.info('xprv:  ' + key.extended_private_key_string());
  this.info('xpub:  ' + key.extended_public_key_string());
  return Q(key.extended_private_key_string());
};

BGCL.prototype.handleCreateWallet = function() {
  var args = this.args;
  var self = this;
  var input = new UserInput(this.args);

  var userkey;
  var backupkey;

  var userKeychain;
  var backupKeychain;
  var bitgoKeychain;

  return this.ensureAuthenticated()
  .then(function() {
    console.log('Create New Wallet ' + self.userHeader());
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
      var keychain = self.bitgo.keychains().create();
      input.userkey = keychain.xprv;
      self.action('Created user key: ' + keychain.xprv);
    }
    try {
      userkey = new bitgo.BIP32(input.userkey);
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
      if (input.backupkey.substr(0,4) !== 'xpub') { throw new Error(); }
      backupkey = new bitgo.BIP32(input.backupkey);
    } catch (e) {
      throw new Error('Invalid BIP32 xpub for backup key');
    }
  })
  .then(input.getVariable('name', 'Name this wallet: '))
  .then(input.getVariable('password', 'Enter BitGo password: '))
  .then(function() {
    // Create user keychain
    userKeychain = {
      xpub: userkey.extended_public_key_string()
    };
    if (userkey.has_private_key) {
      userKeychain.encryptedXprv = self.bitgo.encrypt({
        password: input.password,
        input: userkey.extended_private_key_string()
      });
    }
    return self.bitgo.keychains().add(userKeychain);
  })
  .then(function(keychain) {
    // Create backup keychain
    backupKeychain = {
      xpub: backupkey.extended_public_key_string()
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
    var walletParams = {
      "label": input.name,
      "m": 2,
      "n": 3,
      "keychains": [
        { "xpub": userKeychain.xpub },
        { "xpub": backupKeychain.xpub },
        { "xpub": bitgoKeychain.xpub} ]
    };
    return self.bitgo.wallets().add(walletParams);
  })
  .then(function(wallet) {
    self.action('Created wallet ' + wallet.id());
    self.session.currentWallet = wallet.id();
    self.session.save();
    self.action('Current wallet set to: ' + wallet.id());
    return self.handleWallet();
  });
};

BGCL.prototype.modifyAuthError = function(err) {
  if (err.status === 401 && !err.needsOTP) {
    err.message = 'Not logged in';
  }
  return err;
};

BGCL.prototype.ensureAuthenticated = function() {
  return this.bitgo.me()
  .catch(function(err) {
    throw new Error('Not logged in');
  });
};

BGCL.prototype.runCommandHandler = function() {
  var self = this;

  switch(this.args.cmd) {
    case 'login':
      return this.handleLogin();
    case 'logout':
      return this.handleLogout();
    case 'status':
      return this.handleStatus();
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
    case 'send':
    case 'spend':
      return this.handleSend();
    case 'newkey':
      return this.handleNewKey();
    case 'newwallet':
      return this.handleCreateWallet();
    case 'token':
      return this.handleToken();
    default:
      throw new Error('unknown command');
  }
};

BGCL.prototype.run = function() {
  this.args = this.getArgs();

  var network = 'prod';
  if (process.env.BITGO_NETWORK === 'testnet' || this.args.testnet) {
    network = 'testnet';
  }

  bitgo.setNetwork(network);
  this.bitgo = new bitgo.BitGo({
    useProduction: network === 'prod'
  });

  this.session = new Session(this.bitgo);
  this.session.load();

  var self = this;
  Q().then(function() {
    //console.error();
    return self.runCommandHandler(self.args.cmd)
    .then(function() {
      //console.error();
    });
  })
  .catch(function(err) {
    self.modifyAuthError(err);
    console.error(err.message);
    //console.error();
    // console.error(err.stack);
  })
  .done();
};

exports = module.exports = BGCL;
