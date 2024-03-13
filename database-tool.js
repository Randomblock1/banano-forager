import 'dotenv/config';
import { MongoClient } from 'mongodb';
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) {
  throw new Error('MONGO_URL is not set');
}
const dbClient = await new MongoClient(mongoUrl).connect();
const mongoDB = dbClient.db('banano-forager');

console.log('1. Hashes');
console.log('2. Addresses');
console.log('3. Stats');
console.log('4. IPs');
console.log('5. Blacklist');

rl.question('Select a database: ', (answer) => {
  let databaseChoice;
  switch (answer) {
    case '1':
      databaseChoice = 'hashes';
      break;
    case '2':
      databaseChoice = 'addresses';
      break;
    case '3':
      databaseChoice = 'stats';
      break;
    case '4':
      databaseChoice = 'ips';
      break;
    case '5':
      databaseChoice = 'blacklist';
      break;
    default:
      console.log('Invalid choice');
      process.exit(1);
  }
  const database = mongoDB.collection(databaseChoice);

  console.log('1. Find');
  console.log('2. Insert');
  console.log('3. Update');
  console.log('4. Delete');

  // ugh I really want to use Node 18's readline promises. But this already works.

  rl.question('Choose a command: ', (command) => {
    if (command < 1 || command > 4) {
      console.log('Invalid choice');
      process.exit(1);
    }

    rl.question('Choose a field: ', (field) => {
      rl.question(`Enter a value of ${field} including "s for strings: `, async (value) => {
        const json = JSON.parse(`{"${field}": ${value}}`);

        let result;

        if (command === '1') {
          result = await database.findOne(json);
        } else if (command === '2') {
          result = await database.insertOne(json);
        } else if (command === '3') {
          rl.question('Enter a field to update: ', (newField) => {
            rl.question(
              `Enter the new value of ${newField} including "s for strings: `,
              async (newValue) => {
                const newJson = JSON.parse(`{"${newField}": ${newValue}}`);
                result = await database.updateOne(json, { $set: newJson });
              }
            );
          });
        } else if (command === '4') {
          result = await database.deleteOne(json);
        } else {
          console.log('invalid command');
        }

        console.log(result);

        await dbClient.close();
        process.exit(0);
      });
    });
  });
});
