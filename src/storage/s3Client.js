const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
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

/**
 * Stream an arbitrarily large body to S3 using a multipart upload.
 *
 * Unlike `putObject` (which needs the whole buffer in memory), this consumes a
 * Readable stream and uploads it in bounded-size parts, so memory stays flat
 * (~partSize × queueSize) no matter how large the file is. Used for huge
 * uploads such as Excel exports. On any stream/upload error the SDK aborts the
 * in-flight multipart upload, so no partial object is left behind.
 */
async function uploadStream(key, body, contentType) {
  const partSizeMb = Number.parseInt(process.env.S3_UPLOAD_PART_SIZE_MB || "8", 10);
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
    queueSize: Number.parseInt(process.env.S3_UPLOAD_CONCURRENCY || "4", 10),
    partSize: Math.max(partSizeMb, 5) * 1024 * 1024, // S3 minimum part size is 5 MB
    leavePartsOnError: false,
  });
  return upload.done();
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
  uploadStream,
  objectExists,
};
