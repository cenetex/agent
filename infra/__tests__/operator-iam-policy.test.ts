import * as fs from "fs";
import * as path from "path";

interface IamPolicyFixture {
  description: string;
  allowed_actions: string[];
  denied_actions: string[];
  mutation_policy: string;
  notes: string;
}

function loadFixture(): IamPolicyFixture {
  const fixturePath = path.join(__dirname, "__fixtures__", "diagnostic-iam-policy.json");
  const content = fs.readFileSync(fixturePath, "utf-8");
  return JSON.parse(content) as IamPolicyFixture;
}

describe("operator IAM policy fixture", () => {
  const fixture = loadFixture();

  it("fixture file exists and is valid JSON", () => {
    expect(fixture).toBeDefined();
    expect(fixture.description).toContain("diagnostic");
  });

  it("declares read-only mutation policy", () => {
    expect(fixture.mutation_policy).toBe("read-only");
  });

  it("allowed actions contain only read-only APIs", () => {
    const mutationPrefixes = [
      "Put",
      "Delete",
      "Create",
      "Run",
      "Stop",
      "Start",
      "Update",
      "Register",
      "Deregister",
    ];
    for (const action of fixture.allowed_actions) {
      const rest = action.split(":")[1] ?? "";
      const hasMutation = mutationPrefixes.some((p) => rest.includes(p));
      expect(hasMutation).toBe(false);
    }
  });

  it("denied actions include all ECS mutation APIs", () => {
    expect(fixture.denied_actions).toContain("ecs:RunTask");
    expect(fixture.denied_actions).toContain("ecs:StopTask");
    expect(fixture.denied_actions).toContain("ecs:StartTask");
    expect(fixture.denied_actions).toContain("ecs:UpdateService");
    expect(fixture.denied_actions).toContain("ecs:UpdateTaskDefinition");
    expect(fixture.denied_actions).toContain("ecs:RegisterTaskDefinition");
    expect(fixture.denied_actions).toContain("ecs:DeregisterTaskDefinition");
  });

  it("denied actions include all S3 mutation APIs", () => {
    expect(fixture.denied_actions).toContain("s3:PutObject");
    expect(fixture.denied_actions).toContain("s3:DeleteObject");
    expect(fixture.denied_actions).toContain("s3:PutBucketPolicy");
    expect(fixture.denied_actions).toContain("s3:DeleteBucket");
  });

  it("denied actions include all CloudWatch Logs mutation APIs", () => {
    expect(fixture.denied_actions).toContain("logs:CreateLogGroup");
    expect(fixture.denied_actions).toContain("logs:CreateLogStream");
    expect(fixture.denied_actions).toContain("logs:PutLogEvents");
    expect(fixture.denied_actions).toContain("logs:DeleteLogGroup");
    expect(fixture.denied_actions).toContain("logs:DeleteLogStream");
  });

  it("no action appears in both allowed and denied lists", () => {
    const allowed = new Set(fixture.allowed_actions);
    for (const denied of fixture.denied_actions) {
      expect(allowed.has(denied)).toBe(false);
    }
  });
});

describe("operator IAM policy — stack.ts deny statement", () => {
  const stackSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "stack.ts"),
    "utf-8"
  );

  function extractDenyBlock(): string {
    const denyBlock = stackSource.match(
      /effect:\s*iam\.Effect\.DENY[\s\S]*?\}\s*\)/
    );
    expect(denyBlock).toBeTruthy();
    return denyBlock![0];
  }

  it("stack.ts includes an explicit deny for ECS mutation APIs", () => {
    const block = extractDenyBlock();
    expect(block).toContain("ecs:RunTask");
    expect(block).toContain("ecs:StopTask");
    expect(block).toContain("ecs:UpdateService");
  });

  it("stack.ts includes an explicit deny for S3 mutation APIs", () => {
    const block = extractDenyBlock();
    expect(block).toContain("s3:PutObject");
    expect(block).toContain("s3:DeleteObject");
  });

  it("stack.ts includes an explicit deny for Logs mutation APIs", () => {
    const block = extractDenyBlock();
    expect(block).toContain("logs:PutLogEvents");
    expect(block).toContain("logs:DeleteLogGroup");
  });

  it("stack.ts uses grantRead (not grantReadWrite) for diagnostic S3", () => {
    const grantSection = stackSource.match(
      /Grant S3 read-only permissions[\s\S]*?artifactsBucket\.grantRead\(diagnosticTaskRole\)/
    );
    expect(grantSection).toBeTruthy();
    expect(grantSection![0]).not.toContain("grantReadWrite");
  });
});
