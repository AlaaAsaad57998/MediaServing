const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
let s3;
if (process.env.NODE_ENV !== "production") {
  s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
} else {
  s3 = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

const BUCKET = process.env.S3_BUCKET || "media";

async function getObjectStream(key) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const response = await s3.send(command);
  return response;
}

async function getObjectBuffer(key, opts = {}) {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(opts.range ? { Range: opts.range } : {}),
  });
  const response = await s3.send(command);
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: response.ContentType,
    contentLength: response.ContentLength,
    contentRange: response.ContentRange,
    etag: response.ETag,
  };
}

async function getObjectMetadata(key) {
  const response = await s3.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
  );

  return {
    contentLength: response.ContentLength,
    contentType: response.ContentType,
    etag: response.ETag,
  };
}

async function putObject(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  return s3.send(command);
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

module.exports = {
  s3,
  BUCKET,
  getObjectStream,
  getObjectBuffer,
  getObjectMetadata,
  putObject,
  objectExists,
};
