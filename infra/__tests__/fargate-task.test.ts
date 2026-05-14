import {
  createRunTaskInput,
  parseTaskAssignPublicIp,
} from '../lib/fargate-task';

describe('fargate task helpers', () => {
  it('creates a private Fargate run-task request', () => {
    const input = createRunTaskInput({
      clusterArn: 'arn:cluster',
      taskDefinitionArn: 'arn:task-def',
      containerName: 'agent',
      subnets: 'subnet-a, subnet-b',
      securityGroup: 'sg-123',
      assignPublicIp: 'DISABLED',
      environment: {
        FOO: 'bar',
        BAZ: 'qux',
      },
    });

    expect(input).toMatchObject({
      cluster: 'arn:cluster',
      taskDefinition: 'arn:task-def',
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-a', 'subnet-b'],
          securityGroups: ['sg-123'],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'agent',
            environment: [
              { name: 'FOO', value: 'bar' },
              { name: 'BAZ', value: 'qux' },
            ],
          },
        ],
      },
    });
  });

  it('rejects empty subnet configuration', () => {
    expect(() =>
      createRunTaskInput({
        clusterArn: 'arn:cluster',
        taskDefinitionArn: 'arn:task-def',
        containerName: 'agent',
        subnets: ' , ',
        securityGroup: 'sg-123',
        assignPublicIp: 'ENABLED',
        environment: {},
      })
    ).toThrow('At least one subnet is required');
  });

  it('parses public IP mode defensively', () => {
    expect(parseTaskAssignPublicIp('DISABLED')).toBe('DISABLED');
    expect(parseTaskAssignPublicIp('disabled')).toBe('DISABLED');
    expect(parseTaskAssignPublicIp('ENABLED')).toBe('ENABLED');
    expect(parseTaskAssignPublicIp(undefined)).toBe('ENABLED');
  });
});
