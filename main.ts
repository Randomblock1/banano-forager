import formidable from 'formidable'
import express from 'express'
import fs from 'fs'
import bananojs from '@bananocoin/bananojs'
import mobilenet from '@tensorflow-models/mobilenet'
import { ready as tensorflowGetReady } from '@tensorflow/tfjs-node'
import { decodeImage } from '@tensorflow/tfjs-node/dist/image.js'
import { imageHash } from 'image-hash'
import { ToadScheduler, SimpleIntervalJob, AsyncTask } from 'toad-scheduler'
import axios from 'axios'
import google from 'googlethis'
import FormData from 'form-data'
import 'dotenv/config'
import { verify } from 'hcaptcha'
import { MongoClient } from 'mongodb'

const scheduler = new ToadScheduler()
const app = express()
app.set('view engine', 'pug')
// fix for heroku request proxy ip overwrite
app.set('trust proxy', 1)

const mongoUrl = process.env.MONGO_URL
if (!mongoUrl) {
  throw new Error('MONGO_URL is not set')
}
const dbClient = new MongoClient(mongoUrl)
await dbClient.connect()
const hashDB = dbClient.db('banano-forager').collection('hashes')
const claimsDB = dbClient.db('banano-forager').collection('addresses')
const statsDB = dbClient.db('banano-forager').collection('stats')
const ipDB = dbClient.db('banano-forager').collection('ips')

const hcaptchaSiteKey = process.env.HCAPTCHA_SITE_KEY
const hcaptchaSecret = process.env.HCAPTCHA_SECRET_KEY

if (!hcaptchaSiteKey) {
  throw new Error('HCAPTCHA_SITE_KEY is not set')
}

if (!hcaptchaSecret) {
  throw new Error('HCAPTCHA_SECRET_KEY is not set')
}

const settings = {
  node: process.env.NODE_URL || 'https://vault.banano.cc/api/node-api',
  maxReward: Number(process.env.MAX_REWARD) || 1,
  cooldownMs: Number(process.env.COOLDOWN) || 60 * 60 * 1000,
  privateKey: process.env.PRIVATE_KEY,
  address: process.env.ADDRESS
}

// make sure all needed settings are set correctly
if (!settings.privateKey) {
  throw new Error('PRIVATE_KEY is not set')
}

if (!settings.address) {
  throw new Error('ADDRESS is not set')
}

if (!settings.node) {
  throw new Error('NODE_URL is not set')
}

if (!settings.maxReward) {
  throw new Error('MAX_REWARD is not set')
}

if (!settings.cooldownMs) {
  throw new Error('COOLDOWN is not set')
}

console.log(
  'Node: ' +
  settings.node +
  '\nSeed: ' +
  settings.privateKey.slice(0, 10) +
  '...' +
  '\nFaucetReward: ' +
  settings.maxReward.toString()
)

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

async function uploadFile (fileToUpload: string) {
  const form = new FormData()
  form.append('file', fs.createReadStream(fileToUpload))
  form.append('expires', '5m')
  form.append('maxDownloads', '1')
  form.append('autoDelete', 'true')

  const uploadResponse = await axios.postForm('https://file.io', form)
  return 'https://file.io/' + uploadResponse.data.key
}

let bananoBalance: string
async function receiveDonations (): Promise<object> {
  const response = await bananojs.depositUtil.receive(
    console,
    bananojs.bananodeApi,
    bananoAccount,
    // @ts-ignore
    settings.privateKey,
    representative,
    null,
    'ban_'
  )
  if (response.receiveCount > 0) {
    console.log(response.receiveMessage)
    statsDB.updateOne({ type: 'totals' }, { $inc: { totalDonations: 1 } }, { upsert: true })
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

// receive donations every 15 minutes
const task = new AsyncTask(
  'receive donations',
  async () => {
    try {
      const result = await receiveDonations()
      console.log('successfully checked for donations:', result)
    } catch (err) {
      console.log('Error receiving banano: ' + err)
    }
  })

const job = new SimpleIntervalJob({ minutes: 15 }, task)
scheduler.addSimpleIntervalJob(job)

console.log('Balance: ' + await updateBalance())

// SETUP ROUTES //
// send webpages when accessed
app.get('/', (req, res) => {
  res.render('index', {
    bananoBalance,
    faucetReward: settings.maxReward,
    faucetAddress: settings.address,
    cooldown: settings.cooldownMs,
    hcaptchaSiteKey
  })
  statsDB.updateOne({ type: 'totals' }, { $inc: { visits: 1 } }, { upsert: true })
})

// stats page
app.get('/stats', async (req, res) => {
  const stats = await statsDB.findOne({ type: 'totals' })
  const addressCount = await claimsDB.countDocuments({ totalClaims: { $gt: 0 } })
  if (!stats) {
    res.status(500)
    return
  }
  res.render('stats', {
    lastClaim: stats.lastClaim,
    totalClaims: stats.totalClaims,
    totalSent: stats.totalSent,
    totalDupes: stats.totalDupes,
    totalUnoriginal: stats.totalUnoriginal,
    totalDonations: stats.totalDonations,
    totalAddresses: addressCount,
    totalVisits: stats.visits
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
  form.parse(req, async (err, fields, files: any) => {
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

    const claimAddress = fields.address[0]

    // verify captcha
    const captchaResponse = fields['h-captcha-response'][0]
    const captchaValid = await verify(hcaptchaSecret, captchaResponse)
      .then((data) => {
        return data.success
      })
      .catch(console.error)

    if (captchaValid !== true) {
      res.render('fail', {
        errorReason: 'Invalid captcha.'
      })
      console.log('received invalid captcha')
      return
    }

    // verify address
    const addressVerification = validateAddress(claimAddress)
    if (addressVerification !== true) {
      res.render('fail', {
        errorReason: 'Invalid address, reason: ' + addressVerification
      })
      console.log('received invalid address: ' + addressVerification)
      return
    }
    const addressClaim = await claimsDB.findOne({ address: claimAddress })
    if (addressClaim !== null) {
      const cooldownTime = new Date(+addressClaim.lastClaim + settings.cooldownMs)
      if (cooldownTime > new Date()) {
        res.render('cooldown', {
          cooldownTime: +cooldownTime
        })
        console.log('address ' + claimAddress + ' is on cooldown')
        return
      }
    }
    const ipClaim = await ipDB.findOne({ ip: req.ip })
    if (ipClaim !== null) {
      const cooldownTime = new Date(+ipClaim.lastClaim + settings.cooldownMs)
      if (cooldownTime > new Date()) {
        res.render('cooldown', {
          cooldownTime: +cooldownTime
        })
        console.log('ip ' + req.ip + ' is on cooldown')
        return
      }
    }
    // process image
    const imageBuffer = fs.readFileSync(files.image[0].filepath)
    imageHash({ data: imageBuffer }, 16, true, async (error: Error, data: string) => {
      if (error) {
        throw error
      }
      console.log(data)
      const hashResults = await hashDB.find({ hash: data }).toArray()
      if (hashResults.length > 0) {
        res.render('fail', {
          errorReason: 'Image already uploaded'
        })
        statsDB.updateOne({ type: 'totals' }, { $inc: { totalDupes: 1 } }, { upsert: true })
        claimsDB.updateOne({ address: claimAddress }, { $inc: { fails: 1 } }, { upsert: true })
        console.log('user uploaded duplicate image')
      } else {
        const tempUrl = await uploadFile(files.image[0].filepath)
        const imageMatches = await google.search(tempUrl, { ris: true })
        if (imageMatches.results.length > 0) {
          await hashDB.insertOne({ hash: data, original: false })
          res.render('fail', {
            errorReason: 'Image is from the internet. Is it really that hard to photograph a banana?'
          })
          statsDB.updateOne({ type: 'totals' }, { $inc: { totalUnoriginal: 1 } }, { upsert: true })
          claimsDB.updateOne({ address: claimAddress }, { $inc: { fails: 1 } }, { upsert: true })
          console.log('user uploaded unoriginal image')
        } else {
        // delete after processing
          fs.rmSync(files.image[0].filepath)
          // convert image to tensor
          try {
            const tensorImage = decodeImage(imageBuffer, 3, undefined, false)
            // the fun stuff!
            imageClassification(tensorImage).then(async (classificationResult) => {
              console.log('Got an image. Looks like ', classificationResult[0])
              await hashDB.insertOne({ hash: data, original: true, classification: classificationResult[0].className })
              if (classificationResult[0].className === 'banana') {
              // reward based on confidence, may reduce impact of false positives
                const reward = Number((settings.maxReward * classificationResult[0].probability).toFixed(2))
                // send banano
                bananojs.bananoUtil.sendFromPrivateKey(
                  bananojs.bananodeApi,
                  // @ts-ignore
                  settings.privateKey,
                  claimAddress,
                  banToRaw(reward),
                  'ban_'
                ).then(async (txid) => {
                  claimsDB.updateOne({ address: claimAddress }, { $inc: { totalSent: reward, totalClaims: 1 }, $set: { address: claimAddress, lastClaim: new Date() } }, { upsert: true })
                  statsDB.updateOne({ type: 'totals' }, { $inc: { totalSent: reward, totalClaims: 1 }, $set: { lastClaim: new Date() } }, { upsert: true })
                  ipDB.updateOne({ ip: req.ip }, { $inc: { totalSent: reward, totalClaims: 1 }, $set: { lastClaim: new Date() } }, { upsert: true })
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
                claimsDB.updateOne({ address: claimAddress }, { $inc: { fails: 1 } }, { upsert: true })
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
            console.log('user uploaded invalid image from ' + req.ip)
          }
        }
      }
    })
  })
})

// GO TIME! //
const port = process.env.PORT || 8080
app.listen(port, () => {
  console.log('Server listening on http://localhost:' + port + '...\n')
})

process.on('SIGINT', async () => {
  console.log('\nGracefully closing database connections...')
  await dbClient.close()
  console.log('Done.')
  process.exit(0)
})
