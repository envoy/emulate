---
name: aws
description: Emulated AWS cloud services (S3, SQS, SNS, IAM, STS) for local development and testing. Use when the user needs to interact with AWS API endpoints locally, test S3 bucket and object operations, emulate SQS queues and messages, manage IAM users/roles/access keys, test STS assume role, or work without hitting real AWS APIs. Triggers include "AWS emulator", "emulate AWS", "mock S3", "local SQS", "test IAM", "emulate S3", "AWS locally", "STS assume role", or any task requiring local AWS service emulation.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# AWS Emulator

S3, SQS, SNS mobile push, IAM, and STS emulation with AWS SDK-compatible S3 paths and query-style SQS/SNS/IAM/STS endpoints. All state is in-memory, and responses use AWS-compatible XML.

## Start

```bash
# AWS only
npx emulate --service aws

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const aws = await createEmulator({ service: 'aws', port: 4006 })
// aws.url === 'http://localhost:4006'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. Scoped permissions use `s3:*`, `sqs:*`, `iam:*`, `sts:*` patterns.

```bash
curl http://localhost:4006/ \
  -H "Authorization: Bearer test_token_admin"
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
AWS_EMULATOR_URL=http://localhost:4006
```

### AWS SDK v3

```typescript
import { S3Client } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  endpoint: process.env.AWS_EMULATOR_URL,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  forcePathStyle: true,
})
```

```typescript
import { SQSClient } from '@aws-sdk/client-sqs'

const sqs = new SQSClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/sqs`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

```typescript
import { IAMClient } from '@aws-sdk/client-iam'

const iam = new IAMClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/iam`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

## Seed Config

```yaml
aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
        region: eu-west-1
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
        visibility_timeout: 60
      - name: my-app-orders.fifo
        fifo: true
  iam:
    users:
      - user_name: developer
        create_access_key: true
      - user_name: readonly-user
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
        assume_role_policy: '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

Default seed (always created): S3 bucket `emulate-default`, SQS queue `emulate-default-queue`, IAM user `admin` with access key pair (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`).

## API Endpoints

### SNS mobile push

Start with `npx emulate start --service aws --port 4000`.
Use the AWS SNS SDK with the AWS emulator origin as `endpoint`, or use
`GET`/`POST /sns/` with AWS Query parameters (`Version=2010-03-31`). Root SNS
requests are routed by their action or SNS signing scope; S3 keeps its root paths.
The signing scope selects the region, defaulting to `us-east-1` for unsigned
requests. The account ID is `123456789012`. Use dummy credentials: signatures,
IAM authorization, and provider credentials are not verified.

Supported actions: `CreatePlatformApplication`, `GetPlatformApplicationAttributes`,
`SetPlatformApplicationAttributes`, `DeletePlatformApplication`,
`ListPlatformApplications`, `CreatePlatformEndpoint`, `GetEndpointAttributes`,
`SetEndpointAttributes`, `DeleteEndpoint`, `ListEndpointsByPlatformApplication`,
and `Publish` to a platform endpoint. Lists return up to 100 entries and a
`NextToken` when more remain. Applications and endpoints are isolated by application
and region. Identical registrations reuse the endpoint ARN; conflicting registration
attributes return `InvalidParameter`. Endpoint attributes include `Token`, `Enabled`,
and `CustomUserData`. Deleting an application also removes its endpoints.

```ts
import { SNSClient, CreatePlatformApplicationCommand, CreatePlatformEndpointCommand,
  PublishCommand } from '@aws-sdk/client-sns'

const sns = new SNSClient({
  endpoint: 'http://localhost:4000', // AWS emulator port
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
})
const application = await sns.send(new CreatePlatformApplicationCommand({
  Name: 'sample-mobile', Platform: 'APNS_SANDBOX',
  Attributes: { PlatformPrincipal: 'dummy', PlatformCredential: 'dummy' },
}))
const endpoint = await sns.send(new CreatePlatformEndpointCommand({
  PlatformApplicationArn: application.PlatformApplicationArn, Token: 'test-device-token',
}))
const result = await sns.send(new PublishCommand({
  TargetArn: endpoint.EndpointArn,
  MessageStructure: 'json',
  Message: JSON.stringify({
    default: 'Hello',
    APNS_SANDBOX: JSON.stringify({ aps: { alert: 'Hello' } }),
  }),
}))
const captured = await fetch(`http://localhost:4000/_emulate/sns/messages/${result.MessageId}`)
  .then(response => response.json())
console.log(captured.status, captured.payload) // captured, selected payload string
```

Platforms are `APNS`, `APNS_SANDBOX`, and `GCM`. Structured messages require a
string `default`; supplied mobile protocol values must be JSON object strings.
The endpoint's platform selects its payload, falling back to `default`.
Plain string messages are also captured. Invalid messages, missing resources, and
disabled endpoints return AWS XML errors without capturing a message.

Inspect `GET /_emulate/sns/messages` (optionally `?target_arn=<encoded-arn>`) for
captures in insertion order, or `GET /_emulate/sns/messages/:messageId` for a
specific publish result. Each record includes the original message, selected
payload, target ARN, platform, token at publish time, and `status: "captured"`.
The AWS inspector has an SNS tab. Programmatic state is available through
`getAwsStore(store).snsPlatformApplications`, `.snsEndpoints`, and `.snsMessages`.
Captured history survives resource deletion and is cleared with the store reset;
store snapshots include SNS state. There are no default SNS resources or SNS seed
config fields: create applications and endpoints through the API.

Coverage limits: no real device delivery, provider feedback, retries, credential
validation, throttling, topics/subscriptions, SMS, `Subject`, or `MessageAttributes`.
Unsupported publish fields listed here return `InvalidParameter`. Provider payload
schemas beyond the JSON object shape and provider-specific size limits are not
validated. Direct APNs HTTP/2 and direct FCM HTTP v1/legacy endpoints are **not
implemented**. The Apple emulator remains sign-in only; accepting `GCM` or APNs
payloads through SNS does not emulate their direct APIs. Only dummy credentials
and test device tokens should be used; attributes are stored locally as supplied.

### S3

S3 routes use root paths matching the real AWS S3 wire format. Legacy `/s3/` prefixed paths are also supported.

```bash
# List all buckets
curl http://localhost:4006/ \
  -H "Authorization: Bearer $TOKEN"

# Create bucket
curl -X PUT http://localhost:4006/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Delete bucket (must be empty)
curl -X DELETE http://localhost:4006/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Head bucket (check existence, get region)
curl -I http://localhost:4006/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# List objects (with prefix, delimiter, pagination)
curl "http://localhost:4006/my-bucket?prefix=uploads/&delimiter=/&max-keys=100" \
  -H "Authorization: Bearer $TOKEN"

# Put object
curl -X PUT http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -H "x-amz-meta-author: test" \
  --data-binary "file contents"

# Get object
curl http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Head object (metadata only)
curl -I http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Delete object
curl -X DELETE http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Copy object
curl -X PUT http://localhost:4006/dest-bucket/copy.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-amz-copy-source: /source-bucket/original.txt"
```

### SQS

All SQS operations use `POST /sqs/` with `Action` as a form-urlencoded parameter.

```bash
# Create queue
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Action=CreateQueue&QueueName=my-queue"

# Create queue with attributes
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Action=CreateQueue&QueueName=my-queue&Attribute.1.Name=VisibilityTimeout&Attribute.1.Value=30"

# List queues
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueues"

# List queues with prefix filter
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueues&QueueNamePrefix=my-"

# Get queue URL
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueUrl&QueueName=my-queue"

# Get queue attributes
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueAttributes&QueueUrl=<queue_url>"

# Send message
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=<queue_url>&MessageBody=Hello+World"

# Send message with attributes
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=<queue_url>&MessageBody=Hello&MessageAttribute.1.Name=type&MessageAttribute.1.Value.DataType=String&MessageAttribute.1.Value.StringValue=greeting"

# Receive messages
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ReceiveMessage&QueueUrl=<queue_url>&MaxNumberOfMessages=5"

# Delete message
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteMessage&QueueUrl=<queue_url>&ReceiptHandle=<receipt_handle>"

# Purge queue
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=PurgeQueue&QueueUrl=<queue_url>"

# Delete queue
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteQueue&QueueUrl=<queue_url>"
```

### IAM

All IAM operations use `POST /iam/` with `Action` as a form-urlencoded parameter.

```bash
# Create user
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateUser&UserName=new-user"

# Get user
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetUser&UserName=new-user"

# List users
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListUsers"

# Delete user
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteUser&UserName=new-user"

# Create access key
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateAccessKey&UserName=developer"

# List access keys
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListAccessKeys&UserName=developer"

# Delete access key
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteAccessKey&UserName=developer&AccessKeyId=AKIA..."

# Create role
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateRole&RoleName=my-role&AssumeRolePolicyDocument={}"

# Get role
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetRole&RoleName=my-role"

# List roles
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListRoles"

# Delete role
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteRole&RoleName=my-role"
```

### STS

All STS operations use `POST /sts/` with `Action` as a form-urlencoded parameter.

```bash
# Get caller identity
curl -X POST http://localhost:4006/sts/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetCallerIdentity"

# Assume role
curl -X POST http://localhost:4006/sts/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=AssumeRole&RoleArn=arn:aws:iam::123456789012:role/my-role&RoleSessionName=my-session"
```

### Inspector

```bash
# HTML dashboard (shows S3, SQS, IAM state)
curl http://localhost:4006/_inspector?tab=s3
curl http://localhost:4006/_inspector?tab=sqs
curl http://localhost:4006/_inspector?tab=iam
```

## Common Patterns

### Upload and Retrieve an Object

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4006"

# Create bucket
curl -X PUT $BASE/my-data \
  -H "Authorization: Bearer $TOKEN"

# Upload file
curl -X PUT $BASE/my-data/config.json \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"key": "value"}'

# Download file
curl $BASE/my-data/config.json \
  -H "Authorization: Bearer $TOKEN"
```

### Send and Receive SQS Messages

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4006"

# Get queue URL
QUEUE_URL=$(curl -s -X POST $BASE/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueUrl&QueueName=emulate-default-queue" | grep -oP '<QueueUrl>\K[^<]+')

# Send message
curl -X POST $BASE/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=$QUEUE_URL&MessageBody=Hello+from+emulate"

# Receive messages
curl -X POST $BASE/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ReceiveMessage&QueueUrl=$QUEUE_URL&MaxNumberOfMessages=1"
```

### Create IAM User with Access Key

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4006"

# Create user
curl -X POST $BASE/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateUser&UserName=ci-user"

# Generate access key
curl -X POST $BASE/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateAccessKey&UserName=ci-user"
```
