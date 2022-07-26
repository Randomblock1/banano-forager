import formidable from 'formidable'
import express, { response } from 'express'
import yargs from 'yargs'
import YAML from 'yaml'
import fs from 'fs'
import sanitize from 'sanitize-filename'
import bananojs from '@bananocoin/bananojs'
import mobilenet from '@tensorflow-models/mobilenet'
import * as tf from '@tensorflow/tfjs-node'

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
privateKey: xxxxxxxxxxxxxxx # private seed
faucetReward: 0.1 # how much a success is worth
maxQuota: 100 # max banano to send in a day
cooldown: 60 # minutes between address requests`
      )
      console.log(
        'Successfully generated new config file.\nYour config is now:\n\n' +
        fs.readFileSync(yargs.file).toString()
      )
      process.exit(0)
    }
  )
  .help('h')
  .alias('h', 'help')
  .version('version', '1.0').argv

interface Settings {
  node: string
  privateKey: string
  faucetReward: number
  maxQuota: string
  cooldown: string
}

// parse settings.yml for settings
let settings: Settings
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
    settings.privateKey ||
    settings.faucetReward ||
    settings.maxQuota ||
    settings.cooldown) === undefined
) {
  throw new Error(
    'Invalid settings, make sure every required setting is defined'
  )
}

function verifyAddress(address: string) {
  const validationResult: { valid: boolean, message: string } = bananojs.bananoUtil.getBananoAccountValidationInfo(address)
  if (validationResult.valid === true) {
    return true
  } else {
    return validationResult.message
  }
}
let mobilenetModel: any
tf.ready().then(_ => {
  mobilenetModel = mobilenet.load({ version: 2, alpha: 1 })
})

async function imageClassification(image: object) {
  const predictions = (await mobilenetModel).classify(image)
  return predictions
}

console.log(
  'INFO TIME!' +
  '\nNode:' +
  settings.node +
  '\nSeed:' +
  settings.privateKey +
  '\nFaucetReward:' +
  settings.faucetReward +
  '\nMaxQuota:'+
  settings.maxQuota
  )

// send webpages when accessed
app.get('/', (req, res) => {
  res.render('index')
})

app.get('/faucet', (req, res) => {
  res.render('faucet')
})

function filterFunction({ name, originalFilename, mimetype }: any) {
  // keep only images
  return mimetype && mimetype.includes('image')
}

const formidableOptions = {
  hashAlgorithm: 'sha256',
  keepExtensions: true,
  maxFileSize: 2 * 1024 * 1024, // 2MB
  filter: filterFunction
}

function banToRaw(ban: number) {
  return Number(ban * 100000000000000000000000000000)
}

bananojs.bananodeApi.setUrl(settings.node)

function sendBanano(address: string, amount: number) {
  try {
    const sendresponse = bananojs.bananoUtil.sendFromPrivateKey(
      bananojs.bananodeApi,
      settings.privateKey,
      address,
      banToRaw(amount),
      "ban_",
    ).then(_ => {
      console.log('banano sendbanano response', response)
      return response
    })
  } catch (error: any) {
    console.log('banano sendbanano error', error.message);
  }
  return response
}

// set up POST endpoint at /submit
app.post('/submit', (req, res, next) => {
  const form = formidable(formidableOptions)
  form.parse(req, (err, fields, files: any) => {
    if (err) {
      next(err)
      return
    }
    console.log('Received data: ' + JSON.stringify(fields) + ' from ' + req.ip)
    console.log('Received file: ' + files.image + ' from ' + req.ip)
    console.log(files.image[0].filepath)

    // sanitize address
    const address = sanitize(
      fields.address.toString()
    )
    // verify address
    const addressVerification = verifyAddress(address)
    if (addressVerification !== true) {
      res.render('fail', {
        errorReason: 'Invalid address, reason: ' + addressVerification
      })
      console.log('recieved invalid address: ' + addressVerification)
      return
    }
    // process image
    const imageBuffer = fs.readFileSync(files.image[0].filepath)
    const image = tf.node.decodeImage(imageBuffer)
    let classificationResult
    imageClassification(image).then((result) => {
      console.log(result)
      if (result[0].className === 'banana') {
        // send banano
        const txid = bananojs.bananoUtil.sendFromPrivateKey(
          bananojs.bananodeApi,
          settings.privateKey,
          address,
          banToRaw(settings.faucetReward),
          "ban_",
        ).then((response) => {
          console.log('banano sendbanano response', response)
          res.render('success', {
            transactionId: response,
            address: address,
            amount: settings.faucetReward,
            result: JSON.stringify(result)
          })
          return response
        })
        console.log(txid)
      }
    })
  }
  )
})
app.listen(80, () => {
  console.log('Server listening on http://localhost:80 ...')
})