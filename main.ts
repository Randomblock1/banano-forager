import formidable from 'formidable'
import express from 'express'
import yargs from 'yargs'
import YAML from 'yaml'
import fs from 'fs'
import { execSync } from 'child_process'
import sanitize from 'sanitize-filename'
import { getBananoAccountValidationInfo } from '@bananocoin/bananojs'

const app = express()
// use pug for rendering html
app.set('view engine', 'pug')

// parse args
const args: any = yargs(process.argv.slice(2))
  .usage('Usage: $0 [options]')
  .example('$0', 'Start the app')
  .option('settings', {
    alias: 's',
    default: 'settings.yml',
    describe: 'YAML file to load settings from',
    type: 'string'
  })
  .option('dry-run', {
    alias: 'd',
    default: false,
    describe:
      "Don't actually send any banano",
    type: 'boolean'
  })
  .command(
    'generate',
    'make a new config file',
    function (yargs) {
      return yargs.option('file', {
        alias: 'f',
        describe: 'where to save the file to',
        default: 'settings.yml'
      })
    },
    function (yargs) {
      // generate new valid settings yaml
      if (fs.existsSync(yargs.file)) {
        console.log('File already exists. Moving to old_' + yargs.file)
        fs.cpSync(yargs.file, 'old_' + yargs.file)
      }
      fs.writeFileSync(
        yargs.file,
        `node: https://vault.banano.cc/api/node-api # which node to use
privateSeed: xxxxxxxxxxxxxxx # private seed
faucetReward: 0.1 # how much a success is worth
maxQuota: 100 # max banano to send in a day
cooldown: 60 # minutes between address requests`
      )
      console.log(
        'Successfully generated new config file.\nYour config is now:\n\n' +
        fs.readFileSync(yargs.file)
      )
      process.exit(0)
    }
  )
  .help('h')
  .alias('h', 'help')
  .version('version', '1.0').argv


// parse settings.yml for settings
let settings
try {
  settings = YAML.parse(fs.readFileSync(args.settings).toString())
} catch (ENOENT) {
  throw new Error(
    'No settings file exists at ' +
    args.settings +
    ', try running `node ' +
    args.$0 +
    ' generate`'
  )
}
// make sure all needed settings are set (todo: check for correct types)
if (
  (settings.node ||
    settings.privateSeed ||
    settings.faucetReward ||
    settings.maxQuota ||
    settings.cooldown) === undefined
) {
  throw new Error(
    'Invalid settings, make sure every required setting is defined'
  )
}

function verifyAddress(address: string) {
  const validationResult = getBananoAccountValidationInfo(address)
  if (validationResult.valid == true) {
    return true
  } else {
    return validationResult.message
  }
}

console.log('INFO TIME!' + '\nNode:' + settings.node + '\nSeed:' + settings.privateSeed + '\nFaucetReward:' + settings.faucetReward + '\nMaxQuota:' + settings.maxQuota)

// send webpages when accessed
app.get('/', (req, res) => {
  res.render('index')
})

app.get('/form', (req, res) => {
  res.render('form')
})

// set up POST endpoint at /submit
app.post('/submit', (req, res, next) => {
  const form = formidable({})
  form.parse(req, (err, fields) => {
    if (err) {
      next(err)
      return
    }

    console.log('Received data: ' + JSON.stringify(fields) + ' from ' + req.ip)
    // sanitize address
    const address = sanitize(
      fields.address.toString()
    )
    const addressVerification = verifyAddress(address)
    if (addressVerification !== true) {
      res.render('fail', {
        errorReason: 'Invalid address, reason: ' + addressVerification
      })
      console.log("recieved invalid address: " + addressVerification)
      return
    }
    // process image
    // TODO: process image
    res.render('success', {
      transactionId: 'TODO',
      address: address
    })
  }
  )
})
app.listen(80, () => {
  console.log('Server listening on http://localhost:80 ...')
})
