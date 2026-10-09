/** Provision ONLY the disposable CI bucket and its explicit, encrypted AppSetting. */
import assert from "node:assert/strict";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@brandai/db";
import { encryptSecret } from "../src/lib/crypto";

const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
const endpoint = new URL(process.env.NOVART_CI_STORAGE_ENDPOINT ?? "http://invalid");
assert.equal(process.env.CI, "true", "Storage provisioning is restricted to disposable CI.");
assert.equal(database.pathname, "/novart_integration_test");
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
assert.equal(endpoint.origin, "http://127.0.0.1:9000");
assert.equal(endpoint.pathname, "/");
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const accessKey = process.env.NOVART_CI_STORAGE_ACCESS_KEY;
const secretKey = process.env.NOVART_CI_STORAGE_SECRET_KEY;
assert.ok(accessKey && secretKey, "Disposable storage credentials are required.");
const bucket = "novart-integration-test";
const client = new S3Client({
  endpoint: endpoint.origin, region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }, maxAttempts: 2,
});
try {
  // Never overwrite a pre-existing environment's admin settings, even if misrouted.
  assert.equal(await prisma.appSetting.count(), 0, "Expected an empty disposable AppSetting table.");
  await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10_000) });
  await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10_000) });
  await prisma.appSetting.create({ data: {
    id: "singleton", storageEndpoint: endpoint.origin, storageRegion: "us-east-1",
    storageBucket: bucket, storageAccessKey: accessKey, storageSecretKey: encryptSecret(secretKey),
    storagePublicUrl: `${endpoint.origin}/${bucket}`, storageForcePathStyle: "true",
  } });
  console.log("PASS disposable private bucket and encrypted application storage configuration created");
} finally {
  client.destroy();
  await prisma.$disconnect();
}
