# The ramblings and voices inside my head

Okay, so I guess I'm doing this. First, I need to make sure that I can even detect the banana, so I guess I'll start with Tensorflow.js.

It needs to be a web application that sends the image to the server, and the server does the rest.

Then, I'll need to check and make sure the images are original. Reverse image lookup, then phashing and storing to prevent duplicates.

Finally, I need to actually send the banano. I guess I'll use [bananojs](https://github.com/BananoCoin/bananojs).

```js
// NOTE TO SELF THIS IS THE FUNCTION WE NEED TO USE
commands['bsendraw'] = async (privateKey, destAccount, amountRaw) => {
  const config = configs.banano;
  bananodeApi.setUrl(config.bananodeUrl);
  try {
    const response = await bananoUtil.sendFromPrivateKey(
        bananodeApi,
        privateKey,
        destAccount,
        amountRaw,
        config.prefix,
    );
    console.log('banano sendbanano response', response);
  } catch (error) {
    console.log('banano sendbanano error', error.message);
  }
};
```

Then I'll make it look nice.
