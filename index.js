import express from 'express';
import { Firestore } from '@google-cloud/firestore';

const app = express();
const firestore = new Firestore({
  databaseId: 'urbanists-mixer-db' 
});

app.get('/', async (req, res) => {
  try {
    // Reference a document inside a "visits" collection
    const docRef = firestore.collection('counters').doc('visits');
    const doc = await docRef.get();

    let count = 1;

    if (doc.exists) {
      // If the document exists, read the existing count and increment it
      count = (doc.data().count || 0) + 1;
      await docRef.update({ count });
    } else {
      // If it doesn't exist, create it
      await docRef.set({ count });
    }

    res.send(`<h1>Hello World!</h1><p>This page has been viewed <strong>${count}</strong> times.</p>`);
  } catch (error) {
    console.error('Error connecting to Firestore:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Cloud Run passes the port via the PORT environment variable
const port = parseInt(process.env.PORT) || 8080;

// 0.0.0.0 tells Express to accept connections from any network interface
app.listen(port, '0.0.0.0', () => {
  console.log(`App listening on port ${port}`);
});