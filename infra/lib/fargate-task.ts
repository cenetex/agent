import type { RunTaskCommandInput } from "@aws-sdk/client-ecs";

export type TaskAssignPublicIp = "ENABLED" | "DISABLED";

export interface CreateRunTaskInputOptions {
  clusterArn: string;
  taskDefinitionArn: string;
  containerName: string;
  subnets: string;
  securityGroup: string;
  environment: Record<string, string | undefined>;
  assignPublicIp: TaskAssignPublicIp;
}

export function parseTaskAssignPublicIp(value: string | undefined): TaskAssignPublicIp {
  if (value?.toUpperCase() === "DISABLED") {
    return "DISABLED";
  }
  return "ENABLED";
}

export function createRunTaskInput(options: CreateRunTaskInputOptions): RunTaskCommandInput {
  const subnets = options.subnets
    .split(",")
    .map((subnet) => subnet.trim())
    .filter(Boolean);

  if (subnets.length === 0) {
    throw new Error("At least one subnet is required to launch a Fargate task");
  }

  return {
    cluster: options.clusterArn,
    taskDefinition: options.taskDefinitionArn,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        securityGroups: [options.securityGroup],
        assignPublicIp: options.assignPublicIp,
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: options.containerName,
          environment: Object.entries(options.environment)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .map(([name, value]) => ({
              name,
              value,
            })),
        },
      ],
    },
  };
}
