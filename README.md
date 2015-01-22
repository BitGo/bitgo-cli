BitGo Command-Line Interface (bitgo-cli)
=========

# Summary
This package provides a NodeJS program (**bitgo**), which is a (mostly) complete command-line interface to [BitGo](https://www.bitgo.com) wallets. It also contains some useful client-side-only commands for key generation.

# Installation

**NodeJS must be installed as a prerequisite.**
```sh
$ npm install -g bitgo-cli
```

# Running

Running **bitgo -h** will produce usage information.

```sh
$ bitgo -h
usage: bitgo [-h] [-v] [-t]
             
             {login,logout,token,status,wallets,wallet,labels,setlabel,removelabel,addresses,newaddress,unspents,unspent,tx,unlock,lock,freezewallet,send,spend,newkey,newwallet,splitkeys,recoverkeys,shell,help}
             ...

BitGo Command-Line

Optional arguments:
  -h, --help            Show this help message and exit.
  -v, --version         Show program's version number and exit.
  -t, --testnet         Use BitGo testnet environment (test.bitgo.com)

subcommands:
  {login,logout,token,status,wallets,wallet,labels,setlabel,removelabel,addresses,newaddress,unspents,unspent,tx,unlock,lock,freezewallet,send,spend,newkey,newwallet,splitkeys,recoverkeys,shell,help}
    login               Sign in to BitGo
    logout              Sign out of BitGo
    token               Get or set the current auth token
    status              Show current status
    wallets             Get list of available wallets
    wallet              Set or get the current wallet
    labels              Show labels
    setlabel            Set a label on any address (in curr. wallet context)
    removelabel         Remove a label on an address (in curr. wallet context)
    addresses           List addresses for the current wallet
    newaddress          Create a new receive address for the current wallet
    unspents            Show unspents in the wallet
    tx                  List transactions on the current wallet
    unlock              Unlock the session to allow transacting
    lock                Re-lock the session
    freezewallet        Freeze (time-lock) the current wallet
    send                Create and send a transaction
    newkey              Create a new BIP32 keychain (client-side only)
    newwallet           Create a new Multi-Sig HD wallet
    splitkeys           Create set of BIP32 keys, split into encrypted shares.
    recoverkeys         Recover key(s) from an output file of 'splitkeys'
    shell               Run the BitGo command shell
    help                Display help
```

# Testnet

By default, **bitgo** will use the production Bitcoin network, and will authenticate
with **www.bitgo.com**. In order to use BitGo's testnet environment at **test.bitgo.com**, either use the **-t** flag on the command line, or set the following environment variable:
```sh
$ export BITGO_NETWORK=testnet
```
The testnet environment is a completely separate namespace from the BitGo production database. You will need to set up separate accounts on [test.bitgo.com](https://test.bitgo.com/) for testing purposes.  Note that in the test environment, while standard Authy codes still work for 2FA, it is also possible to use a code of 0000000 (7 zeroes).

# Sessions
The tool maintains one current login session per network (prod or testnet). The sessions are persisted in JSON format files in **~/.bitgo**.  Each session maintains the user's current auth token, and maintains a current wallet. All of the commands that operate on a wallet use this current wallet context. In order to operate on a different wallet, it must first be selected using the **wallet** command.


# Commands

### A Note on Command-Line Options
Many of the commands have interactive flows, prompting for needed information as they go. Generally, these interactive prompts can be bypassed by providing the corresponding information through a command-line flag.

## login
Authenticate with BitGo, establishing a session.
```sh
$ bitgo login
Email: user@domain.com
Password: ********
2-Step Verification Code: 0000000
*** Logged in as user@domain.com
...
```

## logout
Logout of the current session. Sessions expire in 60 minutes by default.
```sh
$ bitgo logout
```

## token
Show the current auth token:
```sh
$ bitgo token
bab7b73dec9501b8b210ec8d68e1ac26a88b7b8c3c4f6811935d793d627c7d54
```
Set the current auth token; this is an alternate way of changing sessions, or can be used to install a long-lived API token provided by BitGo:
```sh
$ bitgo -t token 24b7b73dec9501b8b210ec8d68e1ac26a88b7b8c3c4f6811935d793d627c7d54
*** Logged in as user@domain.com
```

## status
Show the current session status.
```sh
$ bitgo status
Network: prod
Session file: ~/.bitgo/prod.json
Current User: user@domain.com
Logged in
Current wallet: 3N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
```

## wallets
List the wallets available to the user, with balances. Indicates which wallet is currently selected.
```sh
$ bitgo wallets
```

## wallet
Get or set the current wallet.
```sh
$ bitgo wallet          # shows current wallet information
$ bitgo wallet 3        # selects wallet 3 in the wallets list
$ bitgo wallet <addr>   # selects wallet by address
$ bitgo wallet <name>   # selects wallet by name
```

## labels
Show address labels associated with the current wallet, or all wallets.
```sh
$ bitgo labels        # shows address labels on current wallet
$ bitgo labels -a     # shows address labels on all wallets
```

## setlabel
Label a Bitcoin address in the context of the current wallet.
```sh
$ bitgo setlabel <address> "My label here"
```

## removelabel
Remove label from a Bitcoin address in the context of the current wallet.
```sh
$ bitgo removelabel <address>
```

## addresses
Show receive addresses for the current wallet, and optionally change addresses. Shows
```sh
$ bitgo addresses           # show receive addresses only
$ bitgo addresses -c        # include change addresses
```

## newaddress
Generate a new receive address for the current wallet
```sh
$ bitgo newaddress
*** Created new receive address: 3NCsnZpdioF5ZCmnuSyzeb8nH4Rp4XRzdu1
```

## unspents
Show a list of unspents on the current wallet, optionally filtering by minimum confirms.
```sh
$ bitgo unspents            # show all unspents
$ bitgo unspents -c 6       # show unspents with at least 6 confirms
```

## tx
List transactions on the current wallet.
```sh
$ bitgo tx                  # show last 25 transactions
$ bitgo tx -n 100           # show last 100 transactions
```

## unlock
In order to transact, a BitGo session must first be unlocked, by providing an additional
2-step verification (Authy) code. The **send** command handles prompting for this automatically, but the
wallet can also be unlocked explicitly.
```sh
$ bitgo unlock 1234567     # unlock the session with current Authy code
*** Unlocked session
```

## lock
Explicitly lock the session, preventing further transactions from taking place.
```sh
$ bitgo lock
*** Locked session
```

## send
Send a transaction. This command provides a guided flow, but the needed info may also be provided on the command line.
```sh
$ bitgo -t send       # note, this is Testnet (due to the -t)
Current wallet: 2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX
Send Transaction:

Destination address: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Amount (in BTC): 0.5
Wallet passcode: ********************
Optional comment: paying Mike for lunch
Please confirm sending BTC 0.5000 + 0.0001 blockchain fee to 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Type 'go' to confirm: go
2-step Verification Code: 0000000
*** Unlocked session
*** Sent transaction 9ef2042647ceb0b1ec8f18733ab46d11c330b4449549fe37a9c559e170806d0e
```

## newkey
Create a new BIP32 root key. This is a client-side only operation. It does not require the user to be authenticated with BitGo, and does not contact the BitGo server.  Additional entropy may be provided on the command line.
```sh
$bitgo newkey
*** Created new BIP32 keychain

Seed:  cf44970e1a5b972a7abc5023be35069806db8d7213e6d36696bd0082acb65fbe
xprv:  xprv9s21ZrQH143K4VhG7qJDmkxy8RKWte5nQtL7eDdExjcjAttQGv7jA5C9mKEFCqJ4iEpnTombJtHyLgtmtGhETJWoxzHnTwxPBAoNouR49JQ
xpub:  xpub661MyMwAqRbcGymjDrqE8tuhgTA1J6odn7FiSc2rX59i3hDYpTRyhsWdccmcbRku4MgqAVTnq9tnc5cQZCBa6STbMrGVwiRmXKvdYabwaok
```

## newwallet
Create a new BitGo HD 2-of-3 Multi-sig wallet. This is a guided flow with instructions. You will need to provide 1 xprv and 1 xpub, or 2 xpubs in order to create the wallet.

**Please be aware that creating a wallet in this manner does not produce a recovery KeyCard. You are fully responsible for backing up your keys. If you lose access to your keys and passcode, BitGo cannot help you recover your funds.**

```sh
$ bitgo -t newwallet
Current User: ben+0@bitgo.com
Create New Wallet undefined

First, we need the user keychain. Enter a BIP32 xprv below, or press
return to generate one automatically. Your user key is encrypted locally
with your password, and stored on BitGo's server.

User key (xprv or xpub): xprv9s21ZrQH143K4VhG7qJD...

Next, we need the backup keychain. Enter a BIP32 xpub below. It is recommended
to generate the backup keychain on a different machine using reliable
BIP32 key generation software. For instance, you can use the 'keychain'
sub-command to generate a keychain

Backup key (xpub): xpub661MyMwAqRbcG7xHfBQqNLMNS...
Name this wallet: My Command Line Wallet
Enter BitGo password: ********************
*** Created wallet 2N3So1bs9fuLeA3MrsBGPmkaYMXGWQn1HWG
```

## shell
Launch the BitGo shell, which simply allows you to run commands without prefixing them with **bitgo**. No other shell functionality is provided. Use Ctrl-C or Ctrl-D to exit.
```sh
bitgo -t shell
[bitgo @ My Cool Wallet]฿ status
```

## splitkeys
This is a client-side utility command which assists in generating a batch of BIP32 keys which are split
using Shamir Secret Sharing, and have the shares encrypted with separate passwords (each
known by a separate person, generally).  It provides a guided flow, as well as command-line args.
```sh
$ splitkeys -h
usage: bitgo splitkeys [-h] [-m M] [-n N] [-N NKEYS] [-p PREFIX] [-e ENTROPY]

Optional arguments:
  -h, --help            Show this help message and exit.
  -m M                  number of shares required to reconstruct a key
  -n N                  total number of shares per key
  -N NKEYS, --nkeys NKEYS
                        total number of keys to generate
  -p PREFIX, --prefix PREFIX
                        output file prefix
  -e ENTROPY, --entropy ENTROPY
                        additional user-supplied entropy
```

# recoverkeys
A client-side utility for recovering keys generated by splitkeys.
```sh
$bitgo recoverkeys -h
usage: bitgo recoverkeys [-h] [-f FILE] [-k KEYS]

Optional arguments:
  -h, --help            Show this help message and exit.
  -f FILE, --file FILE  the input file (JSON format)
  -k KEYS, --keys KEYS  comma-separated list of key indices to recover
```

