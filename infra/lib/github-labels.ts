export interface GitHubLabelDefinition {
  name: string;
  color: string;
  description: string;
}

interface GitHubErrorObject {
  code?: unknown;
  message?: unknown;
}

interface GitHubErrorResponse {
  message?: unknown;
  errors?: unknown;
}

function includesAlreadyExists(value: unknown): boolean {
  return typeof value === "string" && /already[_ -]?exists|already exists/i.test(value);
}

export function isLabelAlreadyExistsResponse(responseBody: string): boolean {
  let parsed: GitHubErrorResponse;

  try {
    parsed = JSON.parse(responseBody) as GitHubErrorResponse;
  } catch {
    return includesAlreadyExists(responseBody);
  }

  if (includesAlreadyExists(parsed.message)) {
    return true;
  }

  if (!Array.isArray(parsed.errors)) {
    return false;
  }

  return parsed.errors.some((error) => {
    if (typeof error === "string") {
      return includesAlreadyExists(error);
    }

    if (!error || typeof error !== "object") {
      return false;
    }

    const typedError = error as GitHubErrorObject;
    return (
      includesAlreadyExists(typedError.code) ||
      includesAlreadyExists(typedError.message)
    );
  });
}

export async function assertLabelCreateSucceeded(
  label: GitHubLabelDefinition,
  response: Response
): Promise<void> {
  if (response.status !== 422) {
    return;
  }

  const responseBody = await response.text();
  if (isLabelAlreadyExistsResponse(responseBody)) {
    return;
  }

  throw new Error(
    `GitHub label create for ${label.name} failed with 422: ${responseBody}`
  );
}
