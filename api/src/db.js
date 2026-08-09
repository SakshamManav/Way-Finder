import { MongoClient, ObjectId } from "mongodb";

const MONGO_URL = process.env.WAYFINDER_MONGO_URL || "mongodb://127.0.0.1:27017";
const client = new MongoClient(MONGO_URL);
let db = null;

export async function connectDb() {
  await client.connect();
  db = client.db("wayfinder");
}

export function collections() {
  if (!db) throw new Error("db not connected");
  return {
    repos: db.collection("repos"),
    commit_samples: db.collection("commit_samples"),
    file_metrics: db.collection("file_metrics"),
    flagged_spikes: db.collection("flagged_spikes"),
    ownership_decay: db.collection("ownership_decay"),
    onboarding_path: db.collection("onboarding_path"),
  };
}

export { ObjectId };
