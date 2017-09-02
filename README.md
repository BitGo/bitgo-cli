BitGo Command-Line Interface (bitgo-cli)
=========

# Summary
This package provides a NodeJS program (**bitgo**), which is a (mostly) complete command-line interface to [BitGo](https://www.bitgo.com) wallets. It also contains some useful client-side-only commands for key generation.

[![Known Vulnerabilities](https://snyk.io/test/npm/bitgo-cli/badge.svg)](https://snyk.io/test/npm/bitgo-cli)

# Installation

**NodeJS must be installed as a prerequisite.**
```
$ npm install -g bitgo-cli
```

# Running

Running **bitgo -h** will produce usage information.

```
$ bitgo -h
usage: bitgo [-h] [-v] [-e] [-j]



BitGo Command-Line

Optional arguments:
  -h, --help            Show this help message and exit.
  -v, --version         Show program's version number and exit.
  -e ENV, --env ENV     BitGo environment to use: prod (default) or test. Can
                        also be set with the BITGO_ENV environment variable.
  -j, --json            output JSON (if available)

subcommands:
{login,logout,token,status,wallets,wallet,balance,labels,setlabel,removelabel,addresses,newaddress,tx,unlock,lock,sharewallet,shares,acceptshare,cancelshare,freezewallet,removewallet,unspents,unspent,consolidate,fanout,sendtoaddress,newkey,splitkeys,verifysplitkeys,recoverkeys,dumpwalletuserkey,newwallet,shell,help,createtx,signtx,sendtx,listWebhooks,addWebhook,removeWebhook,util}

    login               Sign in to BitGo
    logout              Sign out of BitGo
    token               Get or set the current auth token
    status              Show current status
    wallets             Get list of available wallets
    wallet              Set or get the current wallet
    balance             Get current wallet balance
    labels              Show labels
    setlabel            Set a label on any address (in curr. wallet context)
    removelabel         Remove a label on an address (in curr. wallet context)
    addresses           List addresses for the current wallet
    newaddress          Create a new receive address for the current wallet
    tx                  List transactions on the current wallet
    unlock              Unlock the session to allow transacting
    lock                Re-lock the session
    sharewallet         Share the current wallet with another user
    shares              List outstanding wallet shares (incoming and outgoing)
    acceptshare         Accept a wallet share invite
    cancelshare         Cancel or decline a wallet share invite
    freezewallet        Freeze (time-lock) the current wallet
    removewallet        Remove a wallet from your account
    unspents            Show unspents in the wallet
    unspent             Same as above command
    consolidate         Consolidate unspents in a wallet
    fanout              Fan out unspents in a wallet
    sendtoaddress       Create and send a transaction
    sendtomany          Create and send a transaction to multiple recepients
    newkey              Create a new BIP32 keychain (client-side only)
    splitkeys           Create set of BIP32 keys, split into encrypted shares.
    verifysplitkeys     Verify the public keys contained in the output file
                        from the splitkeys command
    recoverkeys         Recover key(s) from an output file of 'splitkeys'
    dumpwalletuserkey   Dumps a user xprv given a wallet and passphrase
    newwallet           Create a new Multi-Sig HD wallet
    shell               Run the BitGo command shell
    help                Display help
    createtx            Create an unsigned transaction (online) for signing
                        (the signing can be done offline)
    signtx              Sign a transaction (can be used offline) with an
                        input transaction JSON file
    sendtx              Send a transaction for co-signing to BitGo
    listWebhooks        Show webhooks for the current wallet
    addWebhook          Add a webhook for the current wallet
    removeWebhook       Remove a webhook for the current wallet
    util                Utility commands
```

# Testnet

By default, **bitgo** will use the production Bitcoin network, and will authenticate
with **www.bitgo.com**. In order to use BitGo's test environment at **test.bitgo.com**, either use **-e test** on the command line, or set the following environment variable:
```
$ export BITGO_ENV=test
```
The testnet environment is a completely separate namespace from the BitGo production database. You will need to set up separate accounts on [test.bitgo.com](https://test.bitgo.com/) for testing purposes.  Note that in the test environment, while standard Authy codes still work for 2FA, it is also possible to use a code of 0000000 (7 zeroes).

# Sessions

The tool maintains one current login session per environment (prod or test). The sessions are persisted in JSON format files in **~/.bitgo**.  Each session maintains the user's current auth token, and maintains a current wallet. All of the commands that operate on a wallet use this current wallet context. In order to operate on a different wallet, it must first be selected using the **wallet** command.

# Output formats

A number of the commands support outputting in JSON format as well as the normal human-readable format. To enable JSON output, use the **-j** command
line flag **before** the command, for example:

```
$ bitgo -j status
{
  "env": "test",
  "network": "testnet",
  "sessionFile": "/Users/me/.bitgo/test.json",
  "user": "me@me.com",
  "wallet": "2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao"
}
```

# Commands

### A Note on Command-Line Options
Many of the commands have interactive flows, prompting for needed information as they go. Generally, these interactive prompts can be bypassed by providing the corresponding information through a command-line flag.

## login
Authenticate with BitGo, establishing a session.
```
$ bitgo login
Email: user@domain.com
Password: ********
2-Step Verification Code: 0000000
*** Logged in as user@domain.com
...
```

## logout
Logout of the current session. Sessions expire in 60 minutes by default.
```
$ bitgo logout
```

## token
Show the current auth token:
```
$ bitgo token
bab7b73dec9501b8b210ec8d68e1ac26a88b7b8c3c4f6811935d793d627c7d54
```
Set the current auth token; this is an alternate way of changing sessions, or can be used to install a long-lived API token provided by BitGo:
```
$ bitgo token 24b7b73dec9501b8b210ec8d68e1ac26a88b7b8c3c4f6811935d793d627c7d54
*** Logged in as user@domain.com
```

## status
Show the current session status.
```
$ bitgo status
Network: prod
Session file: ~/.bitgo/prod.json
Current User: user@domain.com
Logged in
Current wallet: 3N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
```

## wallets
List the wallets available to the user, with balances. Indicates which wallet is currently selected.
```
$ bitgo wallets
```

## wallet
Get or set the current wallet.
```
$ bitgo wallet          # shows current wallet information
$ bitgo wallet 3        # selects wallet 3 in the wallets list
$ bitgo wallet <addr>   # selects wallet by address
$ bitgo wallet <name>   # selects wallet by name
```

## balance
Get the balance of the current wallet.
```
$ bitgo balance         # get balance in BTC
$ bitgo balance -c      # get confirmed balance in BTC
$ bitgo balance -u bits # get balance in bits
$ bitgo balance -u sat  # get balance in satoshis
```

## labels
Show address labels associated with the current wallet, or all wallets.
```
$ bitgo labels        # shows address labels on current wallet
$ bitgo labels -a     # shows address labels on all wallets
```

## setlabel
Label a Bitcoin address in the context of the current wallet.
```
$ bitgo setlabel <address> "My label here"
```

## removelabel
Remove label from a Bitcoin address in the context of the current wallet.
```
$ bitgo removelabel <address>
```

## addresses
Show receive addresses for the current wallet, and optionally change addresses. Shows
```
$ bitgo addresses           # show receive addresses only
$ bitgo addresses -c        # include change addresses
$ bitgo -j addresses        # show addresses in JSON format
```

## newaddress
Generate a new receive address for the current wallet
```
$ bitgo newaddress          # get a new receive address
$ bitgo newaddress -c       # get a new change <address>
$ bitgo newaddress -l "foo" # get a new receive address labeled "foo"
```
## tx
List transactions on the current wallet.
```
$ bitgo tx                  # show last 25 transactions
$ bitgo tx -n 100           # show last 100 transactions
$ bitgo -j tx               # show last 25 transactions in JSON format
```

## unlock
In order to transact, a BitGo session must first be unlocked, by providing an additional
2-step verification (Authy) code. The **send** command handles prompting for this automatically, but the
wallet can also be unlocked explicitly.
```
$ bitgo unlock 1234567     # unlock the session with current Authy code
*** Unlocked session
```

## lock
Explicitly lock the session, preventing further transactions from taking place.
```
$ bitgo lock
*** Locked session
```
## sharewallet
Share the current wallet with a user by giving them share, spend, or admin priviliges on the wallet. If no
wallet is specified, it will use the current wallet. You must have admin status on the wallet to use this command.
```
$ bitgo sharewallet 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Share Wallet 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao:

Email address of recipient: user@domain.com
Role ( [a]dmin | [s]pender | [v]iewer ): s
Optional comment for recipient: Spend limit is 100 BTC
Wallet password: *******
2-step Verification Code: 0000000
*** Wallet share created (id=55cd2f4cf1f414280c2c926af4c47874)
```

## shares
Lists outstanding wallet shares (incoming and outgoing)

```
$ bitgo shares

Outgoing Shares:
  ID                                Role     To                  Wallet              Message
  55cd2f4cf1f414280c2c926af4c47874  spender   user@domain.com       0                   Spend limit is 100 BTC
```

## acceptshare
Accept a wallet share invite

```
$ bitgo acceptshare 47874c4fa629c2c082414f1fc4f2dc55
BitGo Password: ********

wallet share accepted
```

## cancelshare
Cancel or decline a wallet share invite

```
$ bitgo cancelshare 47874c4fa629c2c082414f1fc4f2dc55
*** Wallet share canceled
```

## freezewallet
Freeze a BitGo wallet. This command effectively time-locks a wallet, so that BitGo will refuse to sign any transactions until the freeze
expires. Be careful when freezing a wallet, as there is no way to unfreeze a wallet without either waiting for the time to expire without
help from BitGo support.

```
$ bitgo freezewallet -d 60
Please confirm you wish to freeze wallet 'My Wallet' for 60 seconds.
BitGo will not sign any transactions on this wallet until the freeze expires.
Type 'go' to confirm: go
Wallet frozen until 2015-02-03T22:46:56.352Z
```

## removewallet
Remove a wallet from your BitGo account. If the wallet is shared, and you are not the last admin, it removes your access to
the wallet but does not affect other users' access. If you are the last admin on the wallet, it will mark the wallet as deleted
and it will not currently be recoverable without assistance from BitGo.

```
$ bitgo removewallet 2MzoQpTopwMD7dfufGeHHvZYfEDrMdxibTM
Type 'yes' to confirm removing wallet 2MzoQpTopwMD7dfufGeHHvZYfEDrMdxibTM: yes
*** Removed wallet 2MzoQpTopwMD7dfufGeHHvZYfEDrMdxibTM
```

## unspents
Show a list of unspents on the current wallet, optionally filtering by minimum confirms.
```
$ bitgo unspents            # show all unspents
$ bitgo unspents -c 6       # show unspents with at least 6 confirms
```

## unspent
Same command as above

## consolidate
Consolidate the unspents on the current wallet into fewer, bigger unspents, optionally setting the target count of unspents.
```
$ bitgo consolidate         # consolidate all unspents into one
$ bitgo consolidate -t 5    # consolidate all unspents until there are only five unspents left
$ bitgo consolidate -i 10   # consolidate all unspents into one, but only use up to 10 inputs per consolidation transaction
```

## fanout
Fan out the unspents on the current wallet into a set of more, equally large, unspents.
```
$ bitgo fanout -t 20        # fan out all the unspents into a total of 20 unspents
```

## sendtoaddress
Send a transaction. This command provides a guided flow, but the needed info may also be provided on the command line.
```
$ bitgo -e test sendtoaddress
Current wallet: 2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX
Send Transaction:

Destination address: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Amount (in BTC): 0.5
Wallet passcode: ********************
Optional comment: paying Mike for lunch
Please confirm sending BTC 0.5000 + 0.0001 blockchain fee:
  0.5000 to 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Type 'go' to confirm: go
2-step Verification Code: 0000000
*** Unlocked session
*** Sent transaction 9ef2042647ceb0b1ec8f18733ab46d11c330b4449549fe37a9c559e170806d0e
```

## sendtomany
Send a transaction to multiple recepients at once. Similarly to `sendtoaddress`, this command provides a guided flow, but the needed info may also be provided on the command line.
```
$ bitgo -e test sendtomany
Current wallet: 2N9VaC4SDRNNnEy6G8zLF8gnHgkY6LV9PsX
Send Transaction:

JSON dictionary of recipients in address: amountInBTC format, e.g. { "LgAQ524UwZz2Nq59CUb4m5CGVWYSZH83B1": 5, "LUMZucN2rvbVryAYP5Ba43d9NcMedaRNn1": 2 }: { "mjp5HeoDJQHo7yfZSPfcNpSkoBRdPzRjWs": 0.5, "mo4mbU89mkFD8JLZ1aVwRUVbfvYcppwzqe": 0.2, "mfXrwmbR82ht39n7o8ga1AAeVzd9aZTv16": 0.3 }
Wallet passcode: ********************
Optional comment: paying Mike for lunch, Tim for beers
Please confirm sending BTC 1.0000 + 0.0001 blockchain fee:
  0.5000 to mjp5HeoDJQHo7yfZSPfcNpSkoBRdPzRjWs
  0.2000 to mo4mbU89mkFD8JLZ1aVwRUVbfvYcppwzqe
  0.3000 to mfXrwmbR82ht39n7o8ga1AAeVzd9aZTv16
Type 'go' to confirm: go
2-step Verification Code: 0000000
*** Unlocked session
*** Sent transaction 9ef2042647ceb0b1ec8f18733ab46d11c330b4449549fe37a9c559e170806d0e
```

## newkey
Create a new BIP32 root key. This is a client-side only operation. It does not require the user to be authenticated with BitGo, and does not contact the BitGo server.  Additional entropy may be provided on the command line.
```
$ bitgo -j newkey
{
  "seed": "72cc2a8728529c17432031ca5a37851b9dfe254f5427f7ebedb6c15abac22575",
  "xpub": "xpub661MyMwAqRbcGi5Yk7XnMMp9tkfe4hVGpo6QEgmkzjxCEzjxzJJU458dJWJjdErQbVJg5fb6iGvb2o4GKEYbycXMWo1CXYiw4RhexSYZsh2",
  "xprv": "xprv9s21ZrQH143K4E15e5zmzDsRLiq9fEmRTaAoSJN9SQRDNCQpSkzDWGp9TDErubsFHbUwHVEwWgpMssULihY2Rayek52VTVdj1wUXeiV2c56"
}
```

## splitkeys
This is a client-side utility command which assists in generating a batch of BIP32 keys which are split
using Shamir Secret Sharing, and have the shares encrypted with separate passwords (each
known by a separate person, generally).  It provides a guided flow, as well as command-line args.
```
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

## verifysplitkeys
Verifies the xpubs generated by the splitkeys command. This command is useful for verifying
that the shares contained in the input JSON file correspond to the xpub(s) listed in the JSON file
```
$ bitgo verifysplitkeys
Verify Split Keys

Input file (JSON): keys.json
Comma-separated list of key indices to recover: 0,1
Processing 2 keys: 0,1
Password 0: *********

Password 1: ***********

Decrypting Key #0, Part #0
Decrypting Key #0, Part #1
Decrypting Key #1, Part #0
Decrypting Key #1, Part #1
[
  {
    "index": 0,
    "xpub": "xpub661MyMwAqRbcF2CSKyTp1Xv9gSBvkdVQsPh5NwSRaErAXVWhtfYBZeuZxVJA8fayUJoPa4rtMZAWUzVG5XESKvCqTvvED5gErrZuxsyDPrP"
  },
  {
    "index": 1,
    "xpub": "xpub661MyMwAqRbcGrqGfmNuJK41iS4kETkofD6mnNT1CMGcuoeJCvWjNtwzgqfSqXsUYUC7NJWTgnrtxHmy93xGTDe7ZbfXbtgxa9LpD7yD5NQ"
  }
]
```

## recoverkeys
A client-side utility for recovering keys generated by splitkeys.
```
$ bitgo recoverkeys -h
usage: bitgo recoverkeys [-h] [-f FILE] [-k KEYS]

Optional arguments:
  -h, --help            Show this help message and exit.
  -f FILE, --file FILE  the input file (JSON format)
  -k KEYS, --keys KEYS  comma-separated list of key indices to recover
```

## dumpwalletuserkey
Print a wallet's xprv, which is decrypted using the passphrase. If the wallet's encrypted keychain
is not stored by BitGo, there will be no xprv to print.
```
$ bitgo dumpwalletuserkey
Wallet password: ********

Type 'go' to confirm that you want to dump the wallet private key to output: go
xprv9s21ZrQH143K4CD2eRTRFO5Uq8dtjTm9mmNvADopmCRNcRjnELpSZ1C3GZJLNa9YbuLaUPWQMM6fQD5jrKxZ3mFsomcvbsyw9Poq8WVcqXw
```

## newwallet
Create a new BitGo HD 2-of-3 Multi-sig wallet. This is a guided flow with instructions. You will need to provide 1 xprv and 1 xpub, or 2 xpubs in order to create the wallet.

**Please be aware that creating a wallet in this manner does not produce a recovery KeyCard. You are fully responsible for backing up your keys. If you lose access to your keys and passcode, BitGo cannot help you recover your funds.**

```
$ bitgo newwallet
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
```
bitgo shell
[bitgo @ My Cool Wallet]Ƀ status
```

## help
Prints all of the commands and subcommands that bitgo-cli responds to, along with short explanations of each command

## createtx
Creates an unsigned transaction and saves it to a JSON file. This file can then be brought to an offline machine for signing using signtx.

```
$ bitgo createtx -h
usage: bitgo createtx [-h] [-d DEST] [-a AMOUNT] [-f FEE] [-c COMMENT]
                      [-p PREFIX]


Optional arguments:
  -h, --help            Show this help message and exit.
  -d DEST, --dest DEST  the destination address
  -a AMOUNT, --amount AMOUNT
                        the amount in BTC
  -f FEE, --fee FEE     fee to pay for transaction
  -c COMMENT, --comment COMMENT
                        optional private comment
  -p PREFIX, --prefix PREFIX
                        output file prefix

$ bitgo createtx
Current wallet: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Create Unsigned Transaction

Destination address: 2MzoQpTopwMD7dfufGeHHvZYfEDrMdxibTM
Amount (in BTC): 0.3
Blockchain fee (blank to use default fee calculation): 0.001
Optional private comment: payroll funds
Created unsigned transaction for 0.3000 BTC + 0.001 BTC blockchain fee to 2MzoQpTopwMD7dfufGeHHvZYfEDrMdxibTM

Wrote tx20154211455.json
```

## signtx
Signs an unsigned transcation (using JSON file from createtx). Can be performed offline. 

```
$ bitgo signtx -h
usage: bitgo signtx [-h] [-f FILE] [--confirm] [-k KEY] [-p [PREFIX]]

Optional arguments:
  -h, --help            Show this help message and exit.
  -f FILE, --file FILE  the input transaction file (JSON format)
  --confirm             skip interactive confirm step -- be careful!
  -k KEY, --key KEY     xprv (private key) for signing
  -p [PREFIX], --prefix [PREFIX]
                        optional output file prefix

$ bitgo signtx
Input transaction file: tx20154211455.json
Private BIP32 key (xprv): xprv9w5AP8PS54E8vWpadxu24uAdArdQbdvkAKvkYGfo1Y187QGVTgWktL6PGothdFAowKxtZwdQEmEcHdfEzwYtqSdRCzFVM2XvDUtxB4CGS4F
You are signing a transaction from the wallet: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Comment: payroll funds
Output #1: 0.3 BTC to 2MzoQpTopwMD7dfufGeHHvZYfEDrMdxibTM
Output #2: 0.199 BTC to 2PMxwFLAtvXnKC6tv4gpzDs9iWqNArjfMM (verified change address back to wallet)
Type 'go' to confirm: go
Signed transaction using the key provided.
Wrote tx20154211455.signed.json
```

## sendtx
Sends a half-signed transaction on a wallet to BitGo for co-signing and propogation to the Bitcoin network. 
Takes input from a filename (JSON constructed by signtx) or a pure transaction hex. 

```
$ bitgo sendtx -h
usage: bitgo sendtx [-h] [-t TXHEX] [-f [FILE]]

Optional arguments:
  -h, --help            Show this help message and exit.
  -t TXHEX, --txhex TXHEX
                        the transaction hex to send
  -f [FILE], --file [FILE]
                        optional input file containing the tx hex

$ bitgo sendtx 
Current wallet: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
Send Transaction

Transaction (hex or file): tx20154211455.signed.json
2-step Verification Code: 6753460
*** Unlocked session

*** Sent transaction 0c41cef5a1b89c3f9387440169b38fb2465b30e0d23c92368f82c8f571182e03
```

## listWebhooks
Lists the webhooks for the current wallet
```
$ bitgo listWebhooks
Current wallet: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao

Webhooks:
 Type             NumConfirmations  URL
 transaction                     3  http://www.yoursite.com/partner/webhooks
```

## addWebhooks
Adds a webhook to the current wallet.
```
$ bitgo -u http://www.yoursite.com/partner/webhooks -n 3 -t transaction
Current wallet: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao

Webhooks:
 Type             NumConfirmations  URL
 transaction                     3  http://www.yoursite.com/partner/webhooks
 ```

 ## removeWebhook
 Removes a webhook from the current wallet.
 ```
 $ bitgo removeWebhook -u http://www.yoursite.com/partner/webhooks -t transaction
 Current wallet: 2N6d5SYvu1xQeSQnpZ4VNVZ6TcRYcqkocao
 { removed: 1 }
 ```

 ## utils
 Miscellaneous utility commands
 ```
 $ bitgo utils -h
 usage: bitgo util [-h] {recoverlitecoin} ...

 Optional arguments:
   -h, --help         Show this help message and exit.

 Utility commands:
   {recoverlitecoin}
     recoverlitecoin  Helper tool to craft transaction to recover Litecoin
                      mistakenly sent to BitGo Bitcoin multisig addresses on
                      the Litecoin network
 ```

