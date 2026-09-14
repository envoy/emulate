# @envoy/emulators-aws

S3, SQS, IAM, STS, and KMS emulation with AWS SDK-compatible S3 paths and query-style SQS/IAM/STS endpoints. The query services return AWS-compatible XML. KMS uses the AWS JSON 1.1 protocol, as the real service does. S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @envoy/emulators-aws
```

## Endpoints

### S3

S3 routes use root paths matching the real AWS S3 wire format, so the official AWS SDK works out of the box with `forcePathStyle: true`. Legacy `/s3/` prefixed paths are also supported for backward compatibility.

- `GET /` — list all buckets
- `PUT /:bucket` — create bucket
- `DELETE /:bucket` — delete bucket
- `HEAD /:bucket` — check existence
- `GET /:bucket` — list objects (prefix, delimiter, max-keys, continuation-token, start-after)
- `POST /:bucket` — presigned POST upload (browser-style multipart form with policy validation)
- `PUT /:bucket/:key` — put object (supports copy via `x-amz-copy-source`)
- `GET /:bucket/:key` — get object
- `HEAD /:bucket/:key` — head object
- `DELETE /:bucket/:key` — delete object

### SQS
All operations via `POST /sqs/` with `Action` parameter:
- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### IAM
All operations via `POST /iam/` with `Action` parameter:
- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

### STS
All operations via `POST /sts` with `Action` parameter:
- `GetCallerIdentity`, `AssumeRole`, `AssumeRoleWithWebIdentity`

`AssumeRoleWithWebIdentity` accepts any non-empty `WebIdentityToken` and issues credentials for whatever `RoleArn` is asked for, whether or not that role was seeded. The token is never verified. When it happens to look like a JWT its `sub` claim becomes the returned subject, and otherwise the subject is a stable digest of the token. This emulates the response shape, not the trust model.

Both `/sts` and `/sts/` are served. The AWS SDKs resolve a configured endpoint of `.../sts` and post to it with no trailing slash.

### KMS
KMS is the one service here that does not use query/XML. It is AWS JSON 1.1: a `POST /kms` carrying an `X-Amz-Target` header of `TrentService.<Action>` and a JSON body, returning JSON. Both `/kms` and `/kms/` are served.

Two actions are supported, which is what a client needs when it generates its own data key locally and asks KMS only to wrap it:

- `Encrypt` takes `KeyId` and base64 `Plaintext`, and returns `CiphertextBlob` and `KeyId`
- `Decrypt` takes base64 `CiphertextBlob`, and returns `Plaintext` and `KeyId`

`KeyId` may be an alias (`alias/data-encryption`), a key id, or a full ARN. Whatever is asked for is echoed back and travels inside the blob, so `Decrypt` reports the key that wrapped it.

Ciphertext blobs are self-contained. Each one is AES-256-GCM sealed under a fixed key derived from a constant in the source, and carries its own key id, nonce, and authentication tag. Nothing is recorded in the store. A blob therefore still decrypts after the emulator restarts, after its store is reset, and in a different emulator process. That matters when a caller keeps the blob in its own database, where it long outlives any emulator.

Limits, stated plainly: this is a wrapping oracle for tests, not a key manager. The wrapping key is fixed and public, so a blob is readable by anyone with the source. There are no key policies, no grants, no rotation, no key creation, and no access control of any kind. Never point real data at it.

## Auth

Bearer tokens or IAM access key credentials. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.

## Seed Configuration

```yaml
aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
```

## Links

- [Full documentation](https://emulate.dev/aws)
- [GitHub](https://github.com/vercel-labs/emulate)
