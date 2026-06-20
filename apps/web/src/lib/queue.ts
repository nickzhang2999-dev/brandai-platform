import { Queue } from "bullmq";
import IORedis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export const connection = new IORedis(url, { maxRetriesPerRequest: null });

export const recognizeQueue = new Queue("recognize", { connection });
export const parseManualQueue = new Queue("parse-manual", { connection });
export const generateQueue = new Queue("generate", { connection });
export const editQueue = new Queue("edit", { connection });
