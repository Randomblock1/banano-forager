import formidable from 'formidable'
import express from 'express'
import fs from 'fs'
import bananojs from '@bananocoin/bananojs'
import mobilenet from '@tensorflow-models/mobilenet'
import { ready as tensorflowGetReady } from '@tensorflow/tfjs-node'
import { decodeImage } from '@tensorflow/tfjs-node/dist/image.js'
import { imageHash } from 'image-hash'
import { ToadScheduler, SimpleIntervalJob, AsyncTask } from 'toad-scheduler'
import 'dotenv/config'
import { verify } from 'hcaptcha'
import { MongoClient } from 'mongodb'
import fetch from 'node-fetch'
import sharp from 'sharp'
// DISABLED DUE TO GOOGLE RATE LIMITING
// import axios from 'axios'
// import google from 'googlethis'
// import FormData from 'form-data'

const scheduler = new ToadScheduler()
const app = express()
app.set('view engine', 'pug')
// fix for reverse proxy / cloudflare ip overwrite
app.set('trust proxy', 2)

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

const webhookUrl = process.env.WEBHOOK_URL

// copied from prussia's banano faucet
const blacklist = ['ban_3qyp5xjybqr1go8xb1847tr6e1ujjxdrc4fegt1rzhmcmbtntio385n35nju', 'ban_1yozd3rq15fq9eazs91edxajz75yndyt5bpds1xspqfjoor9bdc1saqrph1w', 'ban_1894qgm8jym5xohwkngsy5czixajk5apxsjowi83pz9g6zrfo1nxo4mmejm9', 'ban_38jyaej59qs5x3zim7t4pw5dwixibkjw48tg1t3i9djyhtjf3au7c599bmg3', 'ban_3a68aqticd6wup99zncicrbkuaonypzzkfmmn66bxexfmw1ckf3ewo3fmtm9', 'ban_3f9j7bw9z71gwjo7bwgpfcmkg7k8w7y3whzc71881yrmpwz9e6c8g4gq4puj', 'ban_3rdjcqpm3j88bunqa3ge69nzdzx5a6nqumzc4ei3t1uwg3ciczw75xqxb4ac', 'ban_3w5uwibucuxh9psbpi9rp9qnikh9gywjc94cyp5rxirzsr5mtk5gbr5athoc', 'ban_1pi3knekobemmas387mbq44f9iq9dzfmuodoyoxbs38eh5yqtjmy1imxop6m', 'ban_1awbxp5y7r97hmc1oons5z5nirgyny7jenxcn33ehhzjmotf1pnuoopousur', 'ban_1benisxqto7mbod6ff6u6nugr4ehp5r47n3eyk5ki1m4z4j55txcgai8g8m4', 'ban_3qbwjgtdu7ii67adc1496nkj5wrs5fu117dz4wnkf4h1d6ob35ujh81w9kwm', 'ban_1td89xi8akr7nui9yr5i3gnzcoimkyi5bawmpht7hm164q4qyh7xgytwzs58', 'ban_3xt9hkrtdsud3ahnxknf8cnmsposoq5yktf5dtgxyrtqqiucr3h675rsha5c']

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
/**
 * Make sure banano address is valid
 * @param address Banano address
 * @returns boolean or error message
 */
function validateAddress (address: string): true | string {
  const validationResult: { valid: boolean, message: string } = bananojs.bananoUtil.getBananoAccountValidationInfo(address)
  if (validationResult.valid) {
    return true
  } else {
    return validationResult.message
  }
}

/**
 * Get user IP from behind reverse proxy
 * @param req Express request object
 * @returns IP address
 */
function getRealIp (req: express.Request): string {
  const cloudflareRealIp = req.get('CF-Connecting-IP')
  let ip
  if (cloudflareRealIp !== undefined) {
    ip = cloudflareRealIp
  } else {
    ip = req.ip
  }
  return ip
}

/**
 * Checks if IP is a proxy
 * @param ip IP address
 * @returns boolean
 */
async function isProxy (ip: string): Promise<boolean> {
  const response = await fetch('https://check.getipintel.net/check.php?ip=' + ip + '&format=json', {
    headers: {
      accept: '*/*'
    },
    body: null,
    method: 'GET'
  })
  const body = await response.text()
  const json = JSON.parse(body)
  const proxyData = json.result
  if (proxyData > 0.99) {
    return true
  } else {
    return false
  }
}

async function sendWebhook (url: string, message: string): Promise<void> {
  const params = {
    username: 'banano-forager',
    avatar_url: '',
    content: message
  }
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json'
    },
    body: JSON.stringify(params)
  })
}

/**
 * Makes formidable drop unsupported files
 */
function filterFunction ({ name, originalFilename, mimetype }: formidable.Part): boolean {
  // keep only images
  const file = { name, originalFilename, mimetype }
  const regex = /^image\/(png|jpeg)$/
  return regex.test(file.mimetype || '') // skipcq: JS-0382
}

/**
 * Convert banano to raw
 * @param ban Banano amount
 * @returns raw amount
 */
function banToRaw (ban: number): number {
  // turns out you can split banano, a lot
  return Number(ban * 100000000000000000000000000000)
}

/**
 * Convert raw to banano
 * @param raw Raw amount
 * @returns Banano amount
 */
function rawToBan (raw: number): number {
  // turns out you can split banano, a lot
  return Number(raw / 100000000000000000000000000000)
}

// async function uploadFile (fileToUpload: string) {
//   const form = new FormData()
//   form.append('file', fs.createReadStream(fileToUpload))
//   form.append('expires', '5m')
//   form.append('maxDownloads', '1')
//   form.append('autoDelete', 'true')

//   const uploadResponse = await axios.postForm('https://file.io', form)
//   return 'https://file.io/' + uploadResponse.data.key
// }

let bananoBalance: string

/**
 * Receives banano asynchronously
 * @returns bananojs.depositUtil.receivedResponse
 */
async function receiveDonations (): Promise<object> {
  const response = await bananojs.depositUtil.receive(
    console,
    bananojs.bananodeApi,
    bananoAccount,
    //  @ts-expect-error: program already exits if this is undefined
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

/**
 * Returns the current balance of the faucet in banano
 * @returns Current balance in banano
 */
async function updateBalance () {
  const rawBalance = await bananojs.bananodeApi.getAccountBalanceRaw(bananoAccount)
  bananoBalance = rawToBan(Number(rawBalance)).toFixed(2)
  return bananoBalance
}

/**
 * Logs message with timestamp, IP, and address
 * @param ip The IP of user
 * @param address The banano address of user
 * @param message The message to log
 */
function loggingUtil (ip: string, address: string, message: string): void {
  console.log(`${new Date().toISOString()} | ${ip}: ${address}: ${message}`)
  if (webhookUrl !== undefined) {
    sendWebhook(webhookUrl, `${ip}: ${address}: ${message}`)
  }
}

async function isAddressTooNew (accountHistory: any): Promise<boolean> {
  if (accountHistory.history[accountHistory.history.length - 1].local_timestamp < (new Date().getTime() / 1000) - 30 * 24 * 60 * 60) {
    return true
  } else {
    return false
  }
}

// copied from https://github.com/jetstream0/Banano-Faucet/blob/master/banano.js
async function isAddressBanned (address: string, accountHistory: any, bannedAddresses: string[]): Promise<boolean> {
  if (bannedAddresses.includes(address)) return true
  if (accountHistory.history) {
    for (let i = 0; i < accountHistory.history.length; i++) {
      if (bannedAddresses.includes(accountHistory.history[i].account)) {
        return true
      }
    }
  }
  return false
}

// copied from https://github.com/jetstream0/Banano-Faucet/blob/master/banano.js
async function isAddressUnopened (accountHistory: any): Promise<boolean> {
  if (accountHistory.history === '') {
    return true
  } else {
    return false
  }
}

// INITIALIZATION //
// set banano api settings
bananojs.bananodeApi.setUrl(settings.node)
const publicKey = await bananojs.bananoUtil.getPublicKey(settings.privateKey)
const bananoAccount = bananojs.bananoUtil.getAccount(publicKey, 'ban_')
const representative = 'ban_19potasho7ozny8r1drz3u3hb3r97fw4ndm4hegdsdzzns1c3nobdastcgaa' // JungleTV representative

await updateBalance()

// load mobilenet model once ready
const mobilenetModel = await tensorflowGetReady().then(_ => {
  return mobilenet.load({ version: 2, alpha: 0.75 })
})

// receive donations every 15 minutes
const task = new AsyncTask(
  'receive donations',
  async () => {
    try {
      await receiveDonations()
    } catch (err) {
      console.log('Error receiving banano: ' + String(err))
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
  const [stats, addressCount] = await Promise.all([
    statsDB.findOne({ type: 'totals' }),
    claimsDB.countDocuments({ totalClaims: { $gt: 0 } })
  ])
  if (!stats) {
    res.status(503)
    res.render('fail', {
      message: 'Stats currently unavailable'
    })
    return
  }
  res.render('stats', {
    lastClaim: stats.lastClaim,
    totalClaims: stats.totalClaims,
    totalSent: stats.totalSent.toFixed(2),
    totalDupes: stats.totalDupes,
    totalDonations: stats.totalDonations,
    totalAddresses: addressCount,
    totalVisits: stats.visits,
    bannedAddresses: blacklist
  })
})

// add gobanme support
app.get('/banano.json', (req, res) => {
  res.json({ author: 'Randomblock1', description: 'Banano faucet that makes 1 Banana = 1 BAN a reality', suggested_donation: '10', address: 'ban_1picturessx4aedsf59gm6qjkm6e3od4384m1qpfnotgsuoczbmhdb3e1zkh' })
})

// set up POST endpoint at /submit
app.post('/', (req, res) => {
  const form = formidable(formidableOptions)
  // runs every time someone submits a form
  form.parse(req, async (err, fields, files: any) => {
    const ip = getRealIp(req)
    if (err !== null) {
      res.render('fail', {
        errorReason: 'Error parsing form: ' + err
      })
      console.log(ip + ': Bad image')
      return
    }
    try {
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
    } catch (err) {
      res.status(400)
      res.render('fail', {
        errorReason: 'Bad request'
      })
      return
    }
    // console.log(ip + ': Received address: ' + JSON.stringify(fields.address))
    // console.log(ip + ': Received file: ' + files.image)

    const claimAddress = fields.address[0]

    // verify address
    const addressVerification = validateAddress(claimAddress)
    if (addressVerification !== true) {
      res.render('fail', {
        errorReason: 'Invalid address, reason: ' + addressVerification
      })
      console.log(ip + ': Invalid address: ' + addressVerification)
      return
    }

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
      loggingUtil(ip, claimAddress, 'Invalid captcha')
      return
    }

    // copied from https://github.com/jetstream0/Banano-Faucet/blob/master/banano.js
    // because I need a solution that works (people are already abusing it)
    // check for brand new accounts
    const accountHistory = (await bananojs.getAccountHistory(claimAddress, -1))
    if (await isAddressUnopened(accountHistory)) {
      res.render('fail', {
        errorReason: 'Address has no history.'
      })
      loggingUtil(ip, claimAddress, 'Address has no history')
      return
    }
    if (await isAddressTooNew(accountHistory)) {
      res.render('fail', {
        errorReason: 'Address is too new. Your address must be at least 1 month old.'
      })
      loggingUtil(ip, claimAddress, 'Address is too new')
      return
    }
    if (await isAddressBanned(claimAddress, accountHistory, blacklist)) {
      res.render('fail', {
        errorReason: 'Address blacklisted. If this is in error, please contact me.'
      })
      loggingUtil(ip, claimAddress, 'Address is blacklisted')
      return
    }
    // deny proxies
    if (await isProxy(ip)) {
      res.status(403)
      res.render('fail', {
        errorReason: 'Bad IP. Are you using a proxy?'
      })
      loggingUtil(ip, claimAddress, 'Bad IP')
      return
    }

    // cancel if on cooldown
    const addressClaim = await claimsDB.findOne({ address: claimAddress })
    if (addressClaim !== null) {
      const cooldownTime = new Date(+addressClaim.lastClaim + settings.cooldownMs)
      if (cooldownTime > new Date()) {
        res.render('cooldown', {
          cooldownTime: +cooldownTime
        })
        loggingUtil(ip, claimAddress, 'Address is on cooldown')
        return
      }
    }
    const ipClaim = await ipDB.findOne({ ip })
    if (ipClaim !== null) {
      const cooldownTime = new Date(+ipClaim.lastClaim + settings.cooldownMs)
      if (cooldownTime > new Date()) {
        res.render('cooldown', {
          cooldownTime: +cooldownTime
        })
        loggingUtil(ip, claimAddress, 'IP is on cooldown')
        return
      }
    }

    // process image
    const imageBuffer = await sharp(files.image[0].filepath, { failOn: 'none' }).resize(224, 224, { fit: 'contain' }).toBuffer()
    imageHash({ data: imageBuffer }, 16, true, async (error: Error, data: string) => {
      if (error) {
        res.render('fail', {
          errorReason: error
        })
        loggingUtil(ip, claimAddress, 'Error hashing image: ' + error)
        return
      }
      loggingUtil(ip, claimAddress, 'Image hash: ' + data)
      const hashResults = await hashDB.find({ hash: data }).toArray()
      if (hashResults.length > 0) {
        res.render('fail', {
          errorReason: 'Duplicate image. Is it really that hard to take a picture of a banana?'
        })
        statsDB.updateOne({ type: 'totals' }, { $inc: { totalDupes: 1 } }, { upsert: true })
        claimsDB.updateOne({ address: claimAddress }, { $inc: { fails: 1 } }, { upsert: true })
        loggingUtil(ip, claimAddress, 'Duplicate image')
      } else {
        // DISABLED BECAUSE GOOGLE RATE LIMITS IMAGE SEARCHES A LOT
        // const tempUrl = await uploadFile(files.image[0].filepath)
        // const imageMatches = await google.search(tempUrl, { ris: true })
        // if (imageMatches.results.length > 0) {
        //   hashDB.insertOne({ hash: data, original: false })
        //   res.render('fail', {
        //     errorReason: 'Image is from the internet. Is it really that hard to photograph a banana?'
        //   })
        //   statsDB.updateOne({ type: 'totals' }, { $inc: { totalUnoriginal: 1 } }, { upsert: true })
        //   claimsDB.updateOne({ address: claimAddress }, { $inc: { fails: 1 } }, { upsert: true })
        //   loggingUtil(ip, claimAddress, 'Unoriginal image')
        // } else {
        // convert image to tensor
        try {
          const tensorImage = decodeImage(imageBuffer, 3, undefined, false)
          // the fun stuff!
          await mobilenetModel.classify(tensorImage).then((classificationResult) => {
            tensorImage.dispose()
            loggingUtil(ip, claimAddress, 'Image classification result: ' + JSON.stringify(classificationResult))
            const guess = classificationResult.find(guess => guess.className === 'banana')
            if (guess) {
              // reward based on confidence, may reduce impact of false positives
              const reward = Number((settings.maxReward * guess.probability).toFixed(2))
              // send banano
              bananojs.bananoUtil.sendFromPrivateKey(
                bananojs.bananodeApi,
                // @ts-expect-error: This is defined
                settings.privateKey,
                claimAddress,
                banToRaw(reward),
                'ban_'
              ).then((txid) => {
                // log success
                claimsDB.updateOne({ address: claimAddress }, { $inc: { totalSent: reward, totalClaims: 1 }, $set: { address: claimAddress, lastClaim: new Date() } }, { upsert: true })
                statsDB.updateOne({ type: 'totals' }, { $inc: { totalSent: reward, totalClaims: 1 }, $set: { lastClaim: new Date() } }, { upsert: true })
                ipDB.updateOne({ ip }, { $inc: { totalSent: reward, totalClaims: 1 }, $set: { lastClaim: new Date() } }, { upsert: true })
                loggingUtil(ip, claimAddress, `Sent ${reward.toString()} banano with TXID ${txid}`)
                res.render('success', {
                  transactionId: txid,
                  address: claimAddress,
                  amount: reward,
                  result: classificationResult
                })
                updateBalance()
              }).catch((err) => {
                // catch banano send errors
                loggingUtil(ip, claimAddress, `Error sending banano: ${err}`)
                res.render('fail', { errorReason: err })
              })
            } else {
              // reject non-bananas
              loggingUtil(ip, claimAddress, 'Not a banana.')
              claimsDB.updateOne({ address: claimAddress }, { $inc: { fails: 1 } }, { upsert: true })
              res.render('not-banana', { errorReason: 'Not a banana. Results: ' + JSON.stringify(classificationResult) })
            }
            hashDB.insertOne({ hash: data, original: true, classification: classificationResult })
          }).catch((err) => {
            // catch imageClassification errors
            loggingUtil(ip, claimAddress, `Error classifying image: ${err}`)
            res.render('fail', { errorReason: err })
          })
        } catch (err) {
          // catch decodeImage errors
          res.render('fail', {
            errorReason: 'Invalid image. Must be valid PNG or JPEG.'
          })
          loggingUtil(ip, claimAddress, 'Invalid image. ' + err)
          // }
        }
      }
      // delete after processing, even if it fails
      fs.rmSync(files.image[0].filepath)
    })
  })
})

app.use((req, res) => {
  res.status(404)
  res.render('fail', {
    errorReason: '404: Page not found'
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
