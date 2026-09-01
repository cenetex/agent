import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import * as path from "path";
import { DEFAULT_MONITORED_REPOS } from "./monitored-repos";

// SSM parameter names — created out-of-band (already exist)
const PARAM_GITHUB_APP_ID = "/github-agent/GITHUB_APP_ID";
const PARAM_GITHUB_APP_PRIVATE_KEY = "/github-agent/GITHUB_APP_PRIVATE_KEY";
const PARAM_WEBHOOK_SECRET = "/github-agent/GITHUB_WEBHOOK_SECRET";
const PARAM_OPENROUTER_KEY = "/github-agent/OPENROUTER_API_KEY";
const PARAM_ANTHROPIC_KEY = "/github-agent/ANTHROPIC_API_KEY";
const PARAM_TWITTER_BEARER_TOKEN = "/github-agent/TWITTER_BEARER_TOKEN";
const PARAM_TELEGRAM_BOT_TOKEN = "/github-agent/TELEGRAM_BOT_TOKEN";
const PARAM_TELEGRAM_CHANNEL_ID = "/github-agent/TELEGRAM_CHANNEL_ID";
const MONITORED_REPOS = DEFAULT_MONITORED_REPOS.join(",");

export class GitHubAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ssmParamArns = [
      PARAM_GITHUB_APP_ID,
      PARAM_GITHUB_APP_PRIVATE_KEY,
      PARAM_WEBHOOK_SECRET,
      PARAM_OPENROUTER_KEY,
      PARAM_ANTHROPIC_KEY,
      PARAM_TWITTER_BEARER_TOKEN,
      PARAM_TELEGRAM_BOT_TOKEN,
      PARAM_TELEGRAM_CHANNEL_ID,
    ].map(
      (name) =>
        `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`
    );

    const usePublicSubnets = this.node.tryGetContext("usePublicSubnets") === "true";
    const agentSubnetType = usePublicSubnets
      ? ec2.SubnetType.PUBLIC
      : ec2.SubnetType.PRIVATE_WITH_EGRESS;
    const taskAssignPublicIp = usePublicSubnets ? "ENABLED" : "DISABLED";

    // -------------------------------------------------------
    // VPC — private task subnets by default
    // -------------------------------------------------------
    const vpc = new ec2.Vpc(this, "AgentVpc", {
      maxAzs: 2,
      natGateways: usePublicSubnets ? 0 : 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        ...(usePublicSubnets
          ? []
          : [
              {
                name: "Private",
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                cidrMask: 24,
              },
            ]),
      ],
    });

    const agentSubnets = usePublicSubnets ? vpc.publicSubnets : vpc.privateSubnets;
    const agentSubnetIds = agentSubnets.map((s) => s.subnetId).join(",");

    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSG", {
      vpc,
      description: "Security group for GitHub agent Fargate tasks",
      allowAllOutbound: false,
    });

    // Explicit outbound rules — 443 only for HTTPS
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS outbound for GitHub API, model inference, and AWS APIs"
    );

    // -------------------------------------------------------
    // VPC Endpoints for AWS services
    // -------------------------------------------------------
    // S3 Gateway Endpoint (no charge, better performance)
    vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: agentSubnetType },
      ],
    });

    if (!usePublicSubnets) {
      vpc.addInterfaceEndpoint("EcrApiEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
        subnets: { subnetType: agentSubnetType },
      });
      vpc.addInterfaceEndpoint("EcrDockerEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        subnets: { subnetType: agentSubnetType },
      });
      vpc.addInterfaceEndpoint("CloudWatchLogsEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        subnets: { subnetType: agentSubnetType },
      });
      vpc.addInterfaceEndpoint("SsmEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: agentSubnetType },
      });
    }

    // -------------------------------------------------------
    // S3 Bucket for Task Artifacts
    // -------------------------------------------------------
    const artifactsBucket = new s3.Bucket(this, "TaskArtifactsBucket", {
      bucketName: `github-agent-artifacts-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "cleanup-old-artifacts",
          enabled: true,
          expiration: cdk.Duration.days(30), // Clean up artifacts after 30 days
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      versioned: false,
    });

    // -------------------------------------------------------
    // ECR Repositories
    // -------------------------------------------------------
    const repository = new ecr.Repository(this, "AgentRepo", {
      repositoryName: "github-agent",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 5,
          description: "Keep only 5 images",
        },
      ],
    });

    const reviewRepository = new ecr.Repository(this, "ReviewAgentRepo", {
      repositoryName: "github-agent-review",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 5,
          description: "Keep only 5 images",
        },
      ],
    });

    // -------------------------------------------------------
    // ECS Cluster
    // -------------------------------------------------------
    const cluster = new ecs.Cluster(this, "AgentCluster", {
      vpc,
      clusterName: "github-agent",
    });

    // -------------------------------------------------------
    // Fargate Task Definition
    // -------------------------------------------------------
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for GitHub agent Fargate task",
    });

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for artifacts
    artifactsBucket.grantReadWrite(taskRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, "AgentTask", {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole,
    });

    const containerName = "agent";

    taskDefinition.addContainer(containerName, {
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "github-agent",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        AGENT_EXECUTOR: "codex",
        AGENT_EXECUTOR_PATH: "/usr/local/bin/agent-executor",
      },
    });

    // -------------------------------------------------------
    // Review Fargate Task Definition
    // -------------------------------------------------------
    const reviewTaskRole = new iam.Role(this, "ReviewTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for GitHub review agent Fargate task",
    });

    reviewTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for review artifacts
    artifactsBucket.grantReadWrite(reviewTaskRole);

    const reviewTaskDefinition = new ecs.FargateTaskDefinition(this, "ReviewAgentTask", {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: reviewTaskRole,
    });

    const reviewContainerName = "review-agent";

    reviewTaskDefinition.addContainer(reviewContainerName, {
      image: ecs.ContainerImage.fromEcrRepository(reviewRepository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "github-agent-review",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
    });

    // -------------------------------------------------------
    // Diagnostic Fargate Task Definition
    // -------------------------------------------------------
    const diagnosticTaskRole = new iam.Role(this, "DiagnosticTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for GitHub diagnostic agent Fargate task (read-only AWS access)",
    });

    diagnosticTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for artifacts
    artifactsBucket.grantReadWrite(diagnosticTaskRole);

    // Grant CloudWatch Logs read-only access — scoped to GitHubAgentStack Lambdas only
    diagnosticTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/GitHubAgentStack-*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/GitHubAgentStack-*:*`,
        ],
      })
    );

    const diagnosticTaskDefinition = new ecs.FargateTaskDefinition(this, "DiagnosticAgentTask", {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: diagnosticTaskRole,
    });

    const diagnosticContainerName = "diagnostic-agent";

    diagnosticTaskDefinition.addContainer(diagnosticContainerName, {
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "github-agent-diagnostic",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        AGENT_EXECUTOR: "custom",
        AGENT_EXECUTOR_PATH: "/usr/local/bin/agent-executor",
        AWS_REGION: this.region,
      },
    });

    // -------------------------------------------------------
    // Lambda — Webhook Handler
    // -------------------------------------------------------
    const webhookHandler = new NodejsFunction(this, "WebhookHandler", {
      entry: path.join(__dirname, "webhook-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        DIAGNOSTIC_TASK_DEFINITION_ARN: diagnosticTaskDefinition.taskDefinitionArn,
        REVIEW_TASK_DEFINITION_ARN: reviewTaskDefinition.taskDefinitionArn,
        CONTAINER_NAME: containerName,
        DIAGNOSTIC_CONTAINER_NAME: diagnosticContainerName,
        REVIEW_CONTAINER_NAME: reviewContainerName,
        SUBNETS: agentSubnetIds,
        SECURITY_GROUP: taskSecurityGroup.securityGroupId,
        TASK_ASSIGN_PUBLIC_IP: taskAssignPublicIp,
        WEBHOOK_SECRET_PARAM: PARAM_WEBHOOK_SECRET,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        OPENROUTER_API_KEY_PARAM: PARAM_OPENROUTER_KEY,
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        FRICTIONLESS_PR_FLOW: "true",
      },
    });

    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [
          taskDefinition.taskDefinitionArn,
          diagnosticTaskDefinition.taskDefinitionArn,
          reviewTaskDefinition.taskDefinitionArn,
        ],
      })
    );

    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          taskDefinition.taskRole.roleArn,
          taskDefinition.executionRole!.roleArn,
          diagnosticTaskRole.roleArn,
          diagnosticTaskDefinition.executionRole!.roleArn,
          reviewTaskRole.roleArn,
          reviewTaskDefinition.executionRole!.roleArn,
        ],
      })
    );

    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for task metadata
    artifactsBucket.grantReadWrite(webhookHandler);

    // -------------------------------------------------------
    // Lambda — Review Handler
    // -------------------------------------------------------
    const reviewHandler = new NodejsFunction(this, "ReviewHandler", {
      entry: path.join(__dirname, "review-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        REVIEW_TASK_DEFINITION_ARN: reviewTaskDefinition.taskDefinitionArn,
        REVIEW_CONTAINER_NAME: reviewContainerName,
        SUBNETS: agentSubnetIds,
        SECURITY_GROUP: taskSecurityGroup.securityGroupId,
        TASK_ASSIGN_PUBLIC_IP: taskAssignPublicIp,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        OPENROUTER_API_KEY_PARAM: PARAM_OPENROUTER_KEY,
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        MONITORED_REPOS,
        MAX_REVIEWS_PER_RUN: "1",
      },
    });

    reviewHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [reviewTaskDefinition.taskDefinitionArn],
      })
    );

    reviewHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          reviewTaskDefinition.taskRole.roleArn,
          reviewTaskDefinition.executionRole!.roleArn,
        ],
      })
    );

    reviewHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for review artifacts
    artifactsBucket.grantReadWrite(reviewHandler);

    // -------------------------------------------------------
    // Cleanup/Reaper Lambda
    // -------------------------------------------------------
    const cleanupFunction = new NodejsFunction(this, "CleanupFunction", {
      entry: path.join(__dirname, "cleanup-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
      },
    });

    // Grant permissions to the cleanup function
    cleanupFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:DescribeTasks",
          "ecs:StopTask",
          "ecs:ListTasks"
        ],
        resources: ["*"], // ECS tasks don't have predictable ARNs
      })
    );

    cleanupFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantReadWrite(cleanupFunction);

    // -------------------------------------------------------
    // EventBridge rule to trigger cleanup
    // -------------------------------------------------------
    const cleanupRule = new events.Rule(this, "CleanupRule", {
      description: "Trigger cleanup of stale agent tasks",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "*/2", // Every 2 hours
        day: "*",
        month: "*",
        year: "*",
      }),
    });

    cleanupRule.addTarget(new targets.LambdaFunction(cleanupFunction));

    // -------------------------------------------------------
    // EventBridge rule to trigger review handler
    // -------------------------------------------------------
    const reviewRule = new events.Rule(this, "ReviewRule", {
      description: "Trigger review of coding agent PRs",
      enabled: false,
      schedule: events.Schedule.cron({
        minute: "*/15", // Every 15 minutes
        hour: "*",
        day: "*",
        month: "*",
        year: "*",
      }),
    });

    reviewRule.addTarget(new targets.LambdaFunction(reviewHandler));

    // -------------------------------------------------------
    // Lambda — Merge Triage Handler
    // -------------------------------------------------------
    const mergeTriageHandler = new NodejsFunction(this, "MergeTriageHandler", {
      entry: path.join(__dirname, "merge-triage-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        MONITORED_REPOS,
        MERGE_TRIAGE_AUTO_MERGE: "false",
        MERGE_TRIAGE_MAX_MERGES_PER_RUN: "1",
      },
    });

    mergeTriageHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantReadWrite(mergeTriageHandler);

    // -------------------------------------------------------
    // EventBridge rule to trigger merge triage
    // -------------------------------------------------------
    const mergeTriageRule = new events.Rule(this, "MergeTriageRule", {
      description: "Plan and safely advance merge-ready coding-agent PRs every 15 minutes",
      enabled: false,
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    mergeTriageRule.addTarget(new targets.LambdaFunction(mergeTriageHandler));

    // -------------------------------------------------------
    // Daily Digest Lambda
    // -------------------------------------------------------
    const dailyDigestFunction = new NodejsFunction(this, "DailyDigestFunction", {
      entry: path.join(__dirname, "daily-digest-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
      },
    });

    dailyDigestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantRead(dailyDigestFunction);

    // -------------------------------------------------------
    // EventBridge rule to trigger daily digest (9am UTC)
    // -------------------------------------------------------
    const digestRule = new events.Rule(this, "DailyDigestRule", {
      description: "Trigger daily digest at 9am UTC",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "9",
        day: "*",
        month: "*",
        year: "*",
      }),
    });

    digestRule.addTarget(new targets.LambdaFunction(dailyDigestFunction));

    // -------------------------------------------------------
    // Credit Rescan Lambda (scans for blocked issues when credits available)
    // -------------------------------------------------------
    const creditRescanFunction = new NodejsFunction(this, "CreditRescanFunction", {
      entry: path.join(__dirname, "credit-rescan-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
      },
    });

    creditRescanFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantReadWrite(creditRescanFunction);

    // -------------------------------------------------------
    // EventBridge rule to trigger credit rescan (every hour)
    // -------------------------------------------------------
    const creditRescanRule = new events.Rule(this, "CreditRescanRule", {
      description: "Trigger credit rescan hourly to unblock issues when credits are available",
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
    });

    creditRescanRule.addTarget(new targets.LambdaFunction(creditRescanFunction));


    // -------------------------------------------------------
    // QA Trigger Lambda (nightly QA issue creator)
    // -------------------------------------------------------
    const qaFunction = new NodejsFunction(this, "QAFunction", {
      entry: path.join(__dirname, "qa-trigger.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
      },
    });

    qaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // -------------------------------------------------------
    // EventBridge rule to trigger QA (2am UTC daily)
    // -------------------------------------------------------
    const qaRule = new events.Rule(this, "QARule", {
      description: "Trigger nightly QA check at 2am UTC",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2",
        day: "*",
        month: "*",
        year: "*",
      }),
    });

    qaRule.addTarget(new targets.LambdaFunction(qaFunction));

    // -------------------------------------------------------
    // Escalation Handler Lambda
    // -------------------------------------------------------
    const escalationHandler = new NodejsFunction(this, "EscalationHandler", {
      entry: path.join(__dirname, "escalation-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
      },
    });

    escalationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantReadWrite(escalationHandler);

    // -------------------------------------------------------
    // EventBridge rule to trigger escalation checks (every 15 minutes)
    // -------------------------------------------------------
    const escalationRule = new events.Rule(this, "EscalationRule", {
      description: "Trigger escalation queue update every 15 minutes",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    escalationRule.addTarget(new targets.LambdaFunction(escalationHandler));

    // -------------------------------------------------------
    // Task Status Handler Lambda
    // -------------------------------------------------------
    const taskStatusHandler = new NodejsFunction(this, "TaskStatusHandler", {
      entry: path.join(__dirname, "task-status-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
      },
    });

    taskStatusHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantReadWrite(taskStatusHandler);

    // -------------------------------------------------------
    // EventBridge rule to trigger task status checks (every 30 minutes)
    // -------------------------------------------------------
    const taskStatusRule = new events.Rule(this, "TaskStatusRule", {
      description: "Trigger task status monitoring every 30 minutes",
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
    });

    taskStatusRule.addTarget(new targets.LambdaFunction(taskStatusHandler));

    // -------------------------------------------------------
    // Issue Grooming Handler Lambda
    // -------------------------------------------------------
    const groomingHandler = new NodejsFunction(this, "GroomingHandler", {
      entry: path.join(__dirname, "grooming-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        MONITORED_REPOS,
      },
    });

    groomingHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // -------------------------------------------------------
    // EventBridge rule to trigger issue grooming (every 15 minutes)
    // -------------------------------------------------------
    const groomingRule = new events.Rule(this, "GroomingRule", {
      description: "Trigger issue grooming scan every 15 minutes",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    groomingRule.addTarget(new targets.LambdaFunction(groomingHandler));

    // -------------------------------------------------------
    // Auto-Triage Handler Lambda
    // -------------------------------------------------------
    const triageHandler = new NodejsFunction(this, "TriageHandler", {
      entry: path.join(__dirname, "triage-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        MONITORED_REPOS,
      },
    });

    triageHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    artifactsBucket.grantRead(triageHandler);

    // -------------------------------------------------------
    // EventBridge rule to trigger auto-triage (every 15 minutes)
    // -------------------------------------------------------
    const triageRule = new events.Rule(this, "TriageRule", {
      description: "Trigger auto-triage scan every 15 minutes",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    triageRule.addTarget(new targets.LambdaFunction(triageHandler));

    // -------------------------------------------------------
    // API Gateway HTTP API
    // -------------------------------------------------------
    const httpApi = new apigwv2.HttpApi(this, "WebhookApi", {
      apiName: "github-agent-webhook",
      description: "Receives GitHub webhooks for the agent",
    });

    httpApi.addRoutes({
      path: "/webhook",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "WebhookIntegration",
        webhookHandler
      ),
    });

    // -------------------------------------------------------
    // Digest Publisher Lambda (posts to X/Twitter and Telegram)
    // -------------------------------------------------------
    const digestPublisherFunction = new NodejsFunction(this, "DigestPublisherFunction", {
      entry: path.join(__dirname, "digest-publisher.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        TWITTER_BEARER_TOKEN_PARAM: PARAM_TWITTER_BEARER_TOKEN,
        TELEGRAM_BOT_TOKEN_PARAM: PARAM_TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHANNEL_ID_PARAM: PARAM_TELEGRAM_CHANNEL_ID,
      },
    });

    digestPublisherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    httpApi.addRoutes({
      path: "/digest-publish",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "DigestPublishIntegration",
        digestPublisherFunction
      ),
    });

    // -------------------------------------------------------
    // Unblocker Failure-Graph Collector Lambda
    // -------------------------------------------------------
    const collectorFunction = new NodejsFunction(this, "UnblockerCollector", {
      entry: path.join(__dirname, "unblocker/collector.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        externalModules: [],
      },
      environment: {
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        MONITORED_REPOS,
      },
    });

    collectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    collectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          artifactsBucket.bucketArn,
          `${artifactsBucket.bucketArn}/*`,
        ],
      })
    );

    collectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${artifactsBucket.bucketArn}/unblocker/snapshots/*`],
      })
    );

    collectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      })
    );

    // -------------------------------------------------------
    // EventBridge rule to trigger unblocker collector (every 15 minutes)
    // -------------------------------------------------------
    const collectorRule = new events.Rule(this, "UnblockerCollectorRule", {
      description: "Trigger unblocker failure-graph collector every 15 minutes",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    collectorRule.addTarget(new targets.LambdaFunction(collectorFunction));

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: "URL to configure as GitHub webhook endpoint",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
      description: "ECR repository URI for pushing agent images",
    });

    new cdk.CfnOutput(this, "EcrReviewRepositoryUri", {
      value: reviewRepository.repositoryUri,
      description: "ECR repository URI for pushing review agent images",
    });

    new cdk.CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
      description: "ECS cluster name",
    });

    new cdk.CfnOutput(this, "ArtifactsBucket", {
      value: artifactsBucket.bucketName,
      description: "S3 bucket for task artifacts and metadata",
    });

    new cdk.CfnOutput(this, "TaskNetworkMode", {
      value: usePublicSubnets ? "public-subnets-public-ip" : "private-subnets-nat",
      description: "Network mode used for agent Fargate tasks",
    });
  }
}
