import formidable from 'formidable'
import express from 'express'
import yargs from 'yargs'
import YAML from 'yaml'
import fs from 'fs'
import bananojs from '@bananocoin/bananojs'
import mobilenet from '@tensorflow-models/mobilenet'
import { ready as tensorflowGetReady } from '@tensorflow/tfjs-node'
import { decodeImage } from '@tensorflow/tfjs-node/dist/image.js'
import { imageHash } from 'image-hash'
import { ToadScheduler, SimpleIntervalJob, AsyncTask } from 'toad-scheduler'

const scheduler = new ToadScheduler()
const app = express()
app.set('view engine', 'pug')

// SETUP CONFIGURATION VARIABLES //
const args: any = yargs(process.argv.slice(2))
  .usage('Usage: $0 [options]')
  .example('$0', 'Start the app')
  .option('settings', {
    alias: 's',
    default: 'settings.yml',
    describe: 'YAML file to load settings from',
    type: 'string'
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
      if (fs.existsSync(yargs.file) !== null) {
        console.log('File already exists. Moving to old_' + yargs.file)
        fs.cpSync(yargs.file, 'old_' + yargs.file)
      }
      fs.writeFileSync(
        yargs.file,
        `node: https://vault.banano.cc/api/node-api # which node to use
privateKey: xxxxxxxxxxxxxxx # private key
maxReward: 50 # max ban from a claim
cooldown: 60 # minutes between claims`
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

// parse settings.yml for settings
let settings: {
  node: string
  privateKey: string
  maxReward: number
  cooldown: number
}
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
// make sure all needed settings are set correctly
if (!(
  (typeof settings.node === 'string') &&
  (typeof settings.privateKey === 'string') &&
  (typeof settings.maxReward === 'number') &&
  (typeof settings.cooldown === 'number')
)) {
  throw new Error(
    'Invalid settings, make sure every required setting is defined'
  )
}

const formidableOptions: formidable.Options = {
  hashAlgorithm: 'sha256',
  keepExtensions: true,
  maxFileSize: 5 * 1024 * 1024, // 5MB
  filter: filterFunction
}

// FUNCTION DECLARATIONS //
function validateAddress (address: string): true | string {
  const validationResult: { valid: boolean, message: string } = bananojs.bananoUtil.getBananoAccountValidationInfo(address)
  if (validationResult.valid) {
    return true
  } else {
    return validationResult.message
  }
}

interface ClassificationResult {
  className: string
  probability: number
}

async function imageClassification (image: object): Promise<ClassificationResult[]> {
  // return predictions from an image
  const predictions = (await mobilenetModel).classify(image)
  return predictions
}

function filterFunction ({ name, originalFilename, mimetype }: formidable.Part): boolean {
  // keep only images
  const file = { name, originalFilename, mimetype }
  const regex = /^image\/(png|jpeg|bmp|gif)$/
  return regex.test(file.mimetype || '') // skipcq: JS-0382
}

function banToRaw (ban: number): number {
  // turns out you can split banano, a lot
  return Number(ban * 100000000000000000000000000000)
}

function rawToBan (raw: number): number {
  // turns out you can split banano, a lot
  return Number(raw / 100000000000000000000000000000)
}

let bananoBalance: string
async function receiveDonations (): Promise<object> {
  const response = await bananojs.depositUtil.receive(
    console,
    bananojs.bananodeApi,
    bananoAccount,
    settings.privateKey,
    representative,
    null,
    'ban_'
  )
  if (response.receiveCount > 0) {
    console.log(response.receiveMessage)
    await updateBalance()
    console.log('Balance updated to ' + bananoBalance)
  }
  return response
}

async function updateBalance () {
  const rawBalance = await bananojs.bananodeApi.getAccountBalanceRaw(bananoAccount)
  bananoBalance = rawToBan(Number(rawBalance)).toFixed(2)
  return bananoBalance
}

// INITIALIZATION //
// set banano api settings
bananojs.bananodeApi.setUrl(settings.node)
const publicKey = await bananojs.bananoUtil.getPublicKey(settings.privateKey)
const bananoAccount = bananojs.bananoUtil.getAccount(publicKey, 'ban_')
let representative = await bananojs.bananodeApi.getAccountRepresentative(bananoAccount)
if (!representative) {
  representative = bananoAccount
}
await updateBalance()

// load mobilenet model once ready
const mobilenetModel: Promise<mobilenet.MobileNet> = tensorflowGetReady().then(_ => {
  return mobilenet.load({ version: 2, alpha: 1 })
})

// load hash database
if (!fs.existsSync('hashDB.json')) {
  const array: any = []
  fs.writeFileSync('hashDB.json', JSON.stringify(array))
}
const hashDB = JSON.parse(fs.readFileSync('hashDB.json').toString())

// receive donations every 15 minutes
const task = new AsyncTask(
  'receive donations',
  () => {
    return receiveDonations()
      .then((result) => { console.log('successfully checked for donations: ' + result) })
      .catch((err) => { console.log('Error receiving banano: ' + err) })
  })

const job = new SimpleIntervalJob({ minutes: 15 }, task)

scheduler.addSimpleIntervalJob(job)

console.log(
  'Node: ' +
  settings.node +
  '\nSeed: ' +
  settings.privateKey.slice(0, 10) +
  '...' +
  '\nFaucetReward: ' +
  settings.maxReward.toString()
)

console.log('Balance: ' + await updateBalance())

// SETUP ROUTES //
// send webpages when accessed
app.get('/', (req, res) => {
  res.render('index', {
    balance: bananoBalance,
    faucetReward: settings.maxReward
  })
})

// add gobanme support
app.get('/banano.json', (req, res) => {
  res.send('{ "author":"Randomblock1", "description":"Banano faucet that makes 1 Banana = 1 BAN a reality", "suggested_donation":"10", "address": "ban_1picturessx4aedsf59gm6qjkm6e3od4384m1qpfnotgsuoczbmhdb3e1zkh" }')
})

// TODO: get out of async hell
// set up POST endpoint at /submit
app.post('/', (req, res, next) => {
  const form = formidable(formidableOptions)
  // runs every time someone submits a form
  form.parse(req, (err, fields, files: any) => {
    if (err !== null) {
      next(err)
      return
    }

    if (fields.address[0] === '') {
      res.render('fail', {
        errorReason: 'No address provided'
      })
      return
    } else if (files.image === undefined) {
      res.render('fail', {
        errorReason: 'No image provided'
      })
      return
    }

    console.log('Received data: ' + JSON.stringify(fields) + ' from ' + req.ip)
    console.log('Received file: ' + files.image + ' from ' + req.ip)
    console.log(files.image[0].filepath)

    const claimAddress = fields.address[0]

    // verify address
    const addressVerification = validateAddress(claimAddress)
    if (addressVerification !== true) {
      res.render('fail', {
        errorReason: 'Invalid address, reason: ' + addressVerification
      })
      console.log('received invalid address: ' + addressVerification)
      return
    }
    // process image
    const imageBuffer = fs.readFileSync(files.image[0].filepath)
    imageHash({ data: imageBuffer }, 16, true, (error: Error, data: string) => {
      if (error) {
        throw error
      }
      console.log(data)
      if (hashDB.includes(data)) {
        res.render('fail', {
          errorReason: 'Image already claimed'
        })
        console.log('received duplicate image')
      } else {
        hashDB.push(data)
        fs.writeFileSync('hashDB.json', JSON.stringify(hashDB))
        console.log('added image to hashDB')
        // TODO: check if image is original
        // delete after processing
        fs.rmSync(files.image[0].filepath)
        // convert image to tensor
        try {
          const tensorImage = decodeImage(imageBuffer, 3, undefined, false)
          // the fun stuff!
          imageClassification(tensorImage).then((classificationResult) => {
            console.log('Got an image. Looks like ', classificationResult[0])
            if (classificationResult[0].className === 'banana') {
              // reward based on confidence, may reduce impact of false positives
              const reward = Number((settings.maxReward * classificationResult[0].probability).toFixed(2))
              // send banano
              bananojs.bananoUtil.sendFromPrivateKey(
                bananojs.bananodeApi,
                settings.privateKey,
                claimAddress,
                banToRaw(reward),
                'ban_'
              ).then((txid) => {
                console.log(
                  'Sent ' +
            reward.toString() +
            ' banano to ' +
            claimAddress +
            ' with TXID ' +
            txid
                )
                res.render('success', {
                  transactionId: txid,
                  address: claimAddress,
                  amount: reward,
                  result: classificationResult
                })
              }).catch((err) => {
                // catch banano send errors
                console.log('Error sending banano: ' + err)
                res.render('fail', { errorReason: err })
              })
            } else {
              // reject image
              console.log(claimAddress + ' did not submit a banana')
              res.render('fail', { errorReason: 'Not a banana. Results: ' + JSON.stringify(classificationResult) })
            }
          }).catch((err) => {
            // catch imageClassification errors
            console.log('Error processing image from ' + claimAddress + ': ' + err)
            res.render('fail', { errorReason: err })
          })
        } catch (decodeImageError) {
          res.render('fail', {
            errorReason: 'Invalid image. Must be valid PNG, JPEG, BMP, or GIF.'
          })
          console.log('received invalid image from ' + req.ip)
        }
      }
    })
  })
})

// GO TIME! //
app.listen(80, () => {
  console.log('Server listening on http://localhost:80...\n')
})
