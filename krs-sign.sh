./bin/bitgo krsrecovery -f $1 -r $2
xprv=$(cat .secret-file | jq -r '.prv')
../key-recovery-service-v2/bin/admin.js sign --key $xprv $2
rm .secret-file
