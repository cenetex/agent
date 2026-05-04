import {
  DynamoDBClient,
  UpdateCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { marshallStrict, unmarshall } from "@aws-sdk/util-dynamodb";

export interface CreditBalance {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  version: number;
  last_updated: string;
}

export interface StripeEventClaim {
  claimed_at: string;
  committed_at?: string;
}

// Fail-fast environment variable validation
export function validateEnvironment() {
  const requiredVars = [
    "AWS_REGION",
    "ARTIFACTS_BUCKET",
    "DYNAMODB_CREDITS_TABLE",
  ];

  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// Initialize clients
function createDynamoDbClient() {
  return new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
}

function createS3Client() {
  return new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
}

export async function initializeCreditBalance(
  repoSlug: string,
  dynamoDb?: DynamoDBClient,
  s3?: S3Client
): Promise<CreditBalance> {
  const client = dynamoDb || createDynamoDbClient();
  const now = new Date().toISOString();

  const balance: CreditBalance = {
    repo_slug: repoSlug,
    current_balance: 100, // 100 free credits on signup
    total_purchased: 0,
    version: 0,
    last_updated: now,
  };

  await client.send(
    new PutCommand({
      TableName: process.env.DYNAMODB_CREDITS_TABLE!,
      Item: marshallStrict(balance),
    })
  );

  console.log(`Initialized credit balance for ${repoSlug}: 100 credits`);
  return balance;
}

export async function getCreditBalance(
  repoSlug: string,
  dynamoDb?: DynamoDBClient
): Promise<CreditBalance | null> {
  const client = dynamoDb || createDynamoDbClient();

  try {
    const result = await client.send(
      new GetCommand({
        TableName: process.env.DYNAMODB_CREDITS_TABLE!,
        Key: marshallStrict({ repo_slug: repoSlug }),
      })
    );

    if (!result.Item) {
      return null;
    }

    return unmarshall(result.Item) as CreditBalance;
  } catch (error: any) {
    console.error(`Failed to fetch credit balance for ${repoSlug}:`, error);
    throw error;
  }
}

export async function updateCreditBalanceWithOptimisticLocking(
  repoSlug: string,
  amount: number,
  expectedVersion?: number,
  dynamoDb?: DynamoDBClient
): Promise<CreditBalance> {
  const client = dynamoDb || createDynamoDbClient();
  const now = new Date().toISOString();

  let conditionExpression = "attribute_exists(repo_slug)";
  const expressionAttributeValues: Record<string, any> = {
    ":amount": amount,
    ":one": 1,
    ":now": now,
  };

  if (expectedVersion !== undefined) {
    conditionExpression += " AND #version = :expectedVersion";
    expressionAttributeValues[":expectedVersion"] = expectedVersion;
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: process.env.DYNAMODB_CREDITS_TABLE!,
      Key: marshallStrict({ repo_slug: repoSlug }),
      UpdateExpression:
        "SET current_balance = current_balance + :amount, total_purchased = total_purchased + :amount, #version = #version + :one, last_updated = :now",
      ExpressionAttributeNames: {
        "#version": "version",
      },
      ExpressionAttributeValues: marshallStrict(expressionAttributeValues),
      ConditionExpression: conditionExpression,
      ReturnValues: "ALL_NEW",
    })
  );

  if (!result.Attributes) {
    throw new Error(`Failed to update credit balance for ${repoSlug}`);
  }

  return unmarshall(result.Attributes) as CreditBalance;
}

export async function claimStripeEvent(
  eventId: string,
  repoSlug: string,
  s3Client?: S3Client
): Promise<boolean> {
  const client = s3Client || createS3Client();
  const claimKey = `credits/${repoSlug}/stripe-events/${eventId}`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.ARTIFACTS_BUCKET!,
        Key: claimKey,
        Body: JSON.stringify({
          claimed_at: new Date().toISOString(),
        } as StripeEventClaim),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
    );
    return true;
  } catch (error: any) {
    if (error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412) {
      console.log(`[${eventId}] Event already claimed by another worker`);
      return false;
    }
    throw error;
  }
}

export async function recordLedgerEntry(
  eventId: string,
  repoSlug: string,
  amount: number,
  s3Client?: S3Client
): Promise<string> {
  const client = s3Client || createS3Client();
  const timestamp = new Date();
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");

  const ledgerKey = `credits/${repoSlug}/ledger/${year}/${month}/${eventId}.json`;
  const now = new Date().toISOString();

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.ARTIFACTS_BUCKET!,
      Key: ledgerKey,
      Body: JSON.stringify({
        event_id: eventId,
        amount,
        timestamp: now,
        type: "stripe_purchase",
      }),
      ContentType: "application/json",
    })
  );

  console.log(`[${eventId}] Recorded ledger entry: ${ledgerKey}`);
  return ledgerKey;
}

export async function commitStripeEvent(
  eventId: string,
  repoSlug: string,
  s3Client?: S3Client
): Promise<void> {
  const client = s3Client || createS3Client();
  const claimKey = `credits/${repoSlug}/stripe-events/${eventId}`;

  const claim: StripeEventClaim = {
    claimed_at: new Date().toISOString(),
    committed_at: new Date().toISOString(),
  };

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.ARTIFACTS_BUCKET!,
      Key: claimKey,
      Body: JSON.stringify(claim),
      ContentType: "application/json",
    })
  );
}
