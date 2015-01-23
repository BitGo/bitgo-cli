#!/usr/bin/env node

var ArgumentParser = require('argparse').ArgumentParser;
var bitgo = require('bitgo');
var crypto = require('crypto');
var Q = require('q');
var fs = require('fs');
var moment = require('moment');
var read = require('read');
var readline = require('readline');
var secrets = require('secrets.js');
var sjcl = require('sjcl');
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
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  var deferred = Q.defer();
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
  var self = this;
  var internalPromptPassword = function() {
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
  var self = this;
  return function() {
    return Q().then(function() {
      if (self[name]) {
        return;
      }
      return Q().then(function() {
        if (name == 'password' || name == 'passcode') {
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
  var self = this;
  var password;

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
  var self = this;
  return function() {
    return self.getVariable(name, question, required)()
    .then(function() {
      var value = parseInt(self[name]);
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

var Shell = function(bgcl) {
  this.bgcl = bgcl;
};

Shell.prototype.prompt = function() {
  var bgcl = this.bgcl;
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  var deferred = Q.defer();
  var prompt = '[bitgo';
  if (bgcl.session && bgcl.session.wallet) {
    prompt = prompt + ' @ ' + bgcl.session.wallet.label();
  }
  prompt = prompt + ']\u0e3f ';
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

var Session = function(bitgo) {
  this.bitgo = bitgo;
  this.wallet = undefined;
  this.wallets = {};
  this.labels = {};
};

Session.prototype.load = function() {
  var session = loadJSON(this.bitgo.getEnv());
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
  var wallet = this.wallet;
  var labels = this.labels && this.labels[address];
  if (!labels || labels.length === 0) {
    return undefined;
  }
  if (labels.length === 1) {
    return labels[0].label;
  }
  var foundLabel;
  labels.forEach(function(label) {
    if (label.walletId === wallet.id()) {
      foundLabel = label.label;
      return false; // break out
    }
  });
  if (foundLabel) { return foundLabel; }
  return labels[0].label; // found multiple, return first one
};

var BGCL = function() {
};

BGCL.prototype.createArgumentParser = function() {
  var parser = new ArgumentParser({
    version: '0.1',
    addHelp:true,
    description: 'BitGo Command-Line'
  });
  parser.addArgument(
    ['-e', '--env'], {
      help: 'BitGo environment to use: prod (default) or test. Can also be set with the BITGO_ENV environment variable.'
    }
  );

  var subparsers = parser.addSubparsers({
    title:'subcommands',
    dest:"cmd"
  });
  this.subparsers = subparsers;

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

  // settoken
  var token = subparsers.addParser('token', {
    addHelp: true,
    help: 'Get or set the current auth token'
  });
  token.addArgument(['token'], {nargs: '?', help: 'the token to set'});

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

  // labels
  var labels = subparsers.addParser('labels', {
    addHelp: true,
    help: 'Show labels'
  });
  labels.addArgument(['-a', '--all'], {
    help: 'show labels on all wallets, not just current',
    nargs: 0,
    action: 'storeTrue'
  });

  // setlabel
  var setLabel = subparsers.addParser('setlabel', {
    addHelp: true,
    help: 'Set a label on any address (in curr. wallet context)'
  });
  setLabel.addArgument(['address'], { help: 'the address to label'});
  setLabel.addArgument(['label'], { help: 'the label' });

  // removelabel
  var removeLabel = subparsers.addParser('removelabel', {
    addHelp: true,
    help: 'Remove a label on an address (in curr. wallet context)'
  });
  removeLabel.addArgument(['address'], { help: 'the address from which to remove the label'});

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

  // unspents
  var unspents = subparsers.addParser('unspents', {
    aliases: ['unspent'],
    addHelp: true,
    help: 'Show unspents in the wallet'
  });
  unspents.addArgument(['-c', '--minconf'], {help: 'show only unspents with at least MINCONF confirms'});

  // txlist
  var txList = subparsers.addParser('tx', {
    addHelp: true,
    help: 'List transactions on the current wallet'
  });
  txList.addArgument(['-n'], { help: 'number of transactions to show' });

  // unlock
  var unlock = subparsers.addParser('unlock', {
    addHelp: true,
    help: 'Unlock the session to allow transacting'
  });
  unlock.addArgument(['otp'], {nargs: '?', help: 'the 2-step verification code'});

  // lock
  var lock = subparsers.addParser('lock', {
    addHelp: true,
    help: 'Re-lock the session'
  });

  // freezewallet
  var freezeWallet = subparsers.addParser('freezewallet', {
    addHelp: true,
    help: 'Freeze (time-lock) the current wallet'
  });
  freezeWallet.addArgument(['-d', '--duration'], { help: 'the duration in seconds for which to freeze the wallet' });

  // send
  var send = subparsers.addParser('send', {
    aliases: ['spend'],
    addHelp: true,
    help: 'Create and send a transaction'
  });
  send.addArgument(['-d', '--dest'], {help: 'the destination address'});
  send.addArgument(['-a', '--amount'], {help: 'the amount in BTC'});
  send.addArgument(['-p', '--passcode'], {help: 'the wallet passcode'});
  send.addArgument(['-o', '--otp'], {help: 'the 2-step verification code'});
  send.addArgument(['-c', '--comment'], {help: 'optional comment'});
  send.addArgument(['--confirm'], {action: 'storeConst', constant: 'go', help: 'skip interactive confirm step -- be careful!'});

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

  var splitKeys = subparsers.addParser('splitkeys', {
    addHelp: true,
    help: 'Create set of BIP32 keys, split into encrypted shares.'
  });
  splitKeys.addArgument(['-m'], { help: 'number of shares required to reconstruct a key' });
  splitKeys.addArgument(['-n'], { help: 'total number of shares per key' });
  splitKeys.addArgument(['-N', '--nkeys'], { help: 'total number of keys to generate' });
  splitKeys.addArgument(['-p', '--prefix'], { help: 'output file prefix' });
  splitKeys.addArgument(['-e', '--entropy'], { help: 'additional user-supplied entropy'});

  var recoverKeys = subparsers.addParser('recoverkeys', {
    addHelp: true,
    help: "Recover key(s) from an output file of 'splitkeys'"
  });
  recoverKeys.addArgument(['-f', '--file'], { help: 'the input file (JSON format)'});
  recoverKeys.addArgument(['-k', '--keys'], { help: 'comma-separated list of key indices to recover' });

  // shell
  var shell = subparsers.addParser('shell', {
    addHelp: true,
    help: 'Run the BitGo command shell'
  });

  // help
  var help = subparsers.addParser('help', {
    addHelp: true,
    help: 'Display help'
  });
  help.addArgument(['command'], {nargs: '?'});

  return parser;
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
  console.log('Current wallet: ' + this.session.wallet.id());
};

BGCL.prototype.formatWalletId = function(walletId) {
  var label = this.session.labelForWallet(walletId);
  if (label) {
    return _.string.prune(label, 22);
  }
  var shortened = _.string.prune(walletId, 12);
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

  // If no token set, display current one
  if (!this.args.token) {
    return self.ensureAuthenticated()
    .then(function() {
      self.info(self.bitgo._token);
    });
  }

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
  var self = this;
  return this.bitgo.logout()
  .then(function() {
    self.action('Logged out');
  });
};

BGCL.prototype.handleStatus = function() {
  this.info('Environment: ' + this.bitgo.getEnv() + ' / ' + bitgo.getNetwork());
  this.info('Session file: ' + filename(this.bitgo.getEnv()));
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

    var marker = self.session.wallet.id() == w.id() ? '>> ' : '   ';
    return marker + _.string.pad(index, width) + '  ' + w.id() + '  ' + balance + '  ' + _.string.prune(w.label(), 20);
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
    var newWallet;
    if (setWalletType) {
      var wallet = _.find(sortedWallets, findWallet);
      if (!wallet) {
        throw new Error('Wallet ' + setWallet + ' not found');
      }
      newWallet = wallet;
    } else if (!self.session.wallet && sortedWallets.length) {
      newWallet = sortedWallets[0];
    }
    if (newWallet) {
      self.action('Set current wallet to ' + newWallet.id());
      self.session.wallet = newWallet;
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
  if (!this.session.wallet) {
    throw new Error('No current wallet set. Use the setwallet command to set one.');
  }

  var self = this;
  var wallet;
  return this.bitgo.wallets().get({id: this.session.wallet.id() })
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
    self.info('  Confirmed:    ' + self.toBTC(wallet.confirmedBalance(), 8) + ' BTC');
    self.info('  Recv address: ' + address.address + ' ' + self.inBrackets(address.index) );
  });
};

BGCL.prototype.handleLabels = function() {
  var self = this;
  var labelsByWallet = _.chain(this.session.labels).values().flatten().groupBy('walletId').value();

  if (!this.args.all) {
    var walletId = this.session.wallet.id();
    var labels = labelsByWallet[walletId] || [];
    labelsByWallet = {};
    labelsByWallet[walletId] = labels;
  }

  var sortedWallets = _.sortBy(_.values(this.session.wallets), function(w) { return w.label + w.id; });
  sortedWallets.forEach(function(wallet) {
    var labels = labelsByWallet[wallet.id];
    if (labels) {
      var sortedLabels = _.sortBy(labels, function(label) { return label.label + label.address; });
      self.info(wallet.label);
      sortedLabels.forEach(function(label) {
        var line = '  ' + _.string.rpad(label.address, 38) + _.string.prune(label.label, 60);
        self.info(line);
      });
    }
  });
};

BGCL.prototype.handleSetLabel = function() {
  var self = this;

  // TODO: use label APIs in SDK when available
  var wallet = this.session.wallet;
  var address = this.args.address;
  var label = this.args.label;

  return this.ensureAuthenticated()
  .then(function() {
    if (!self.session.wallet) {
      throw new Error('No current wallet.');
    }
    var url = self.bitgo.url('/labels/' + wallet.id() + '/' + address);
    return self.bitgo.put(url)
    .send({ label: label })
    .result();
  })
  .then(function(result) {
    self.action('Labeled ' + address + " to '" + label + "' in wallet '" + wallet.label() + "'");
    return self.fetchLabels();
  });
};

BGCL.prototype.handleRemoveLabel = function() {
  var self = this;
  // TODO: use label APIs in SDK when available
  var wallet = this.session.wallet;
  var address = this.args.address;

  return this.ensureAuthenticated()
  .then(function() {
    if (!self.session.wallet) {
      throw new Error('No current wallet.');
    }
    var url = self.bitgo.url('/labels/' + wallet.id() + '/' + address);
    return self.bitgo.del(url)
    .result();
  })
  .then(function(result) {
    self.action('Removed label for ' + address + " in wallet '" + wallet.label() + "'");
    return self.fetchLabels();
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
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  var wallet = this.session.wallet;
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
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  return this.session.wallet.createAddress()
  .then(function(address) {
    self.action('Created new receive address: ' + address.address);
    return self.handleWallet();
  });
};

BGCL.prototype.handleUnspents = function() {
  var self = this;
  var minconf = this.args.minconf || 0;
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  return this.session.wallet.unspents()
  .then(function(unspents) {
    var total = 0;
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
          u.tx_hash + ':' + u.tx_output_n
        );
      }
    });
    self.info('\newTotal: ' + self.toBTC(total));
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
        target = _.string.prune(target, 35);
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
      _.string.lpad('Amt', 11) + '  ' +
      _.string.rpad('Description', 42)
    );
    console.log();
    console.log(rows.join('\n'));
  };

  var transactions = [];

  var getTransactions = function(skip, target) {
    var limit = target - transactions.length;
    if (limit <= 0) {
      return;
    }
    if (limit > 500) {
      // Server enforces 500 max
      limit = 500;
    }
    var url = self.session.wallet.url('/wallettx?skip=' + skip + '&limit=' + limit);
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

  var self = this;
  if (!this.session.wallet) {
    throw new Error('No current wallet.');
  }
  var limit = this.args.n || 25;
  return Q().then(function() {
    return getTransactions(0, limit);
  })
  .then(function() {
    self.walletHeader();
    printTxList(transactions);
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

BGCL.prototype.handleFreezeWallet = function() {
  var self = this;
  var input = new UserInput(this.args);

  return this.ensureAuthenticated()
  .then(function() {
    if (!self.session.wallet) {
      throw new Error('No current wallet.');
    }
    return input.getIntVariable('duration', 'Duration in seconds to freeze: ', true, 1, 1e8)();
  })
  .then(function() {
    self.info("Please confirm you wish to freeze wallet '" + self.session.wallet.label() + "' for " + input.duration + ' seconds.');
    self.info('BitGo will not sign any transactions on this wallet until the freeze expires.');
    return input.getVariable('confirm', 'Type \'go\' to confirm: ')();
  })
  .then(function() {
    if (input.confirm !== 'go') {
      throw new Error('Freeze canceled');
    }
    return self.session.wallet.freeze({ duration: input.duration });
  })
  .then(function(result) {
    self.info('Wallet frozen until ' + result.expires);
  });
};

BGCL.prototype.handleSend = function() {
  var self = this;
  var input = new UserInput(this.args);
  var satoshis;

  return this.ensureAuthenticated()
  .then(function() {
    if (!self.session.wallet) {
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
    return self.bitgo.wallets().get({ id: self.session.wallet.id() });
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

BGCL.prototype.genKey = function() {
  this.addEntropy(128);
  var seedLength = 256 / 32; // 256 bits / 32-bit words
  var seed = sjcl.codec.hex.fromBits(sjcl.random.randomWords(seedLength));
  var key = new bitgo.BIP32().initFromSeed(seed);
  return {
    seed: seed,
    xpub: key.extended_public_key_string(),
    xprv: key.extended_private_key_string()
  };
};

BGCL.prototype.handleNewKey = function() {
  if (this.args.entropy) {
    this.addUserEntropy(this.args.entropy);
  }
  this.addEntropy(128);
  var key = this.genKey();
  this.action('Created new BIP32 keychain');
  this.info('Seed:  ' + key.seed);
  this.info('xprv:  ' + key.xprv);
  this.info('xpub:  ' + key.xpub);
  return Q(key);
};

BGCL.prototype.handleNewWallet = function() {
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
    return self.handleWallets(wallet.id());
  });
};

/**
 * Add n bytes of entropy to the SJCL entropy pool from secure crypto
 * @param {Number} nBytes   number of bytes to add
 */
BGCL.prototype.addEntropy = function(nBytes) {
  var buf = bitgo.Util.hexToBytes(crypto.randomBytes(nBytes).toString('hex'));
  // Will throw if the system pool is out of entropy
  sjcl.random.addEntropy(buf, nBytes * 8, "crypto.randomBytes");
};

BGCL.prototype.addUserEntropy = function(userString) {
  // estimate 2 bits of entropy per character
  sjcl.random.addEntropy(userString, userString.length * 2, 'user');
};

/**
 * Generate a new BIP32 key based on a random seed, returning
 * the xpub, along with the encrypted split shares for the seed.
 *
 * @param   {Object} input   the UserInput object with params
 * @param   {Number} index   the index of the key in the batch
 * @returns {Object}         information about the key
 */
BGCL.prototype.genSplitKey = function(params, index) {
  var self = this;
  var key = this.genKey();
  var result = {
    xpub: key.xpub,
    m: params.m,
    n: params.n
  };

  // If n==1, we're not splitting, just encrypt
  var shares;
  if (params.n === 1) {
    shares = [key.seed];
  } else {
    shares = secrets.share(key.seed, params.n, params.m);
  }

  var encryptedShares = shares.map(function(share, shareIndex) {
    var password = params['password' + shareIndex];
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
  var self = this;
  var input = new UserInput(this.args);

  var getPassword = function(i, n) {
    if (i === n) {
      return;
    }
    var passwordName = 'password' + i;
    return input.getPassword(passwordName, 'Password for share ' + i + ': ', true)()
    .then(function() {
      return getPassword(i+1, n);
    });
  };

  return Q().then(function() {
    console.log('Generate Split Keys');
    console.log();
  })
  .then(input.getIntVariable('n', 'Number of shares per key (N): ', true, 1, 10))
  .then(function() {
    var mMin = 2;
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
    var keys = _.range(0, input.nkeys).map(function(index) {
      var key = self.genSplitKey(input);
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
    var filename = input.prefix + '.json';
    fs.writeFileSync(filename, JSON.stringify(keys, null, 2));
    console.log('Wrote ' + filename);
    var csvRows = keys.map(function(key) {
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
  var self = this;
  var input = new UserInput(this.args);
  var passwords = [];
  var keysToRecover;

  /**
   * Get a password from the user, testing it against encrypted shares
   * to determine which (if any) index of the shares it corresponds to.
   *
   * @param   {Number} i      index of the password (0..n-1)
   * @param   {Number} n      total number of passwords needed
   * @param   {String[]}   shares   list of encrypted shares
   * @returns {Promise}
   */
  var getPassword = function(i, n, shares) {
    if (i === n) {
      return;
    }
    var passwordName = 'password' + i;
    return input.getPassword(passwordName, 'Password ' + i + ': ', false)()
    .then(function() {
      var password = input[passwordName];
      var found = false;
      shares.forEach(function(share, shareIndex) {
        try {
          sjcl.decrypt(password, share);
          if (!passwords.some(function(p) { return p.shareIndex === shareIndex; })) {
            passwords.push({shareIndex: shareIndex, password: password});
            found = true;
          }
        } catch (err) {}
      });
      if (found) {
        return getPassword(i+1, n, shares);
      }
      console.log('bad password - try again');
      delete input[passwordName];
      return getPassword(i, n, shares);
    });
  };

  return Q().then(function() {
    console.log('Recover Keys');
    console.log();
  })
  .then(input.getVariable('file', 'Input file (JSON): '))
  .then(input.getVariable('keys', 'Comma-separated list of key indices to recover: '))
  .then(function() {
    // Grab the list of keys from the file
    var json = fs.readFileSync(input.file);
    var keys = JSON.parse(json);

    // Determine and validate the indices of the keys to recover
    var indices = input.keys.split(',')
      .map(function(x) { return parseInt(x,10); })
      .filter(function(x) { return !isNaN(x); });
    indices = _.uniq(indices).sort(function(a,b) { return a-b; });
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

    console.log('Recovering ' + keysToRecover.length + ' keys: ' + indices);

    // Get the passwords
    var firstKey = keysToRecover[0];
    return getPassword(0, firstKey.m, firstKey.seedShares);
  })
  .then(function() {
    // For each key we want to recover, decrypt the shares, recombine
    // into a seed, and produce the xprv, validating against existing xpub.
    var recoveredKeys = keysToRecover.map(function(key) {
      var shares = passwords.map(function(p) {
        return sjcl.decrypt(p.password, key.seedShares[p.shareIndex]);
      });
      var seed = secrets.combine(shares);
      var bip32 = new bitgo.BIP32().initFromSeed(seed);
      var xpub = bip32.extended_public_key_string();
      var xprv = bip32.extended_private_key_string();
      if (xpub !== key.xpub) {
        throw new Error("xpubs don't match for key " + key.index);
      }
      return {
        index: key.index,
        xpub: key.xpub,
        xprv: xprv
      };
    });
    console.log(JSON.stringify(recoveredKeys, null, 2));
  });
};

BGCL.prototype.handleShellCommand = function() {
  var self = this;
  return this.shell.prompt()
  .then(function(line) {
    var args = line.split(' ');
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
    var cmdParser = this.subparsers._nameParserMap[this.args.command];
    if (!cmdParser) {
      console.log('unknown command');
    } else {
      console.log(cmdParser.formatHelp());
    }
    return;
  }
  var help = this.parser.formatHelp();
  // If we're in a shell, just grab the subcommands section
  if (this.shell) {
    var lines = help.split('\n');
    var subcommandsLine = lines.indexOf('subcommands:');
    lines = lines.slice(subcommandsLine+2);
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

BGCL.prototype.ensureAuthenticated = function() {
  return this.bitgo.me()
  .catch(function(err) {
    throw new Error('Not logged in');
  });
};

BGCL.prototype.runCommandHandler = function(cmd) {
  var self = this;

  switch(cmd) {
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
    case 'freezewallet':
      return this.handleFreezeWallet();
    case 'unspents':
    case 'unspent':
      return this.handleUnspents();
    case 'send':
    case 'spend':
      return this.handleSend();
    case 'newkey':
      return this.handleNewKey();
    case 'splitkeys':
      return this.handleSplitKeys();
    case 'recoverkeys':
      return this.handleRecoverKeys();
    case 'newwallet':
      return this.handleNewWallet();
    case 'token':
      return this.handleToken();
    case 'shell':
      return this.runShell();
    case 'help':
      return this.handleHelp();
    default:
      throw new Error('unknown command');
  }
};

BGCL.prototype.run = function() {
  this.parser = this.createArgumentParser();
  this.args = this.parser.parseArgs();

  // Setup BitGo for chosen environment
  var env = this.args.env || process.env.BITGO_ENV || 'prod';
  this.bitgo = new bitgo.BitGo({ env: env });

  this.session = new Session(this.bitgo);
  this.session.load();

  var self = this;
  Q().then(function() {
    //console.error();
    return self.runCommandHandler(self.args.cmd);
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
