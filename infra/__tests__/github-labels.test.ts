import {
  assertLabelCreateSucceeded,
  isLabelAlreadyExistsResponse,
} from "../lib/github-labels";

describe("GitHub label helpers", () => {
  it("recognizes GitHub's already-exists label validation response", () => {
    expect(
      isLabelAlreadyExistsResponse(
        JSON.stringify({
          message: "Validation Failed",
          errors: [
            {
              resource: "Label",
              code: "already_exists",
              field: "name",
            },
          ],
        })
      )
    ).toBe(true);
  });

  it("does not hide unrelated 422 label failures", async () => {
    const response = new Response(
      JSON.stringify({
        message: "Validation Failed",
        errors: [
          {
            resource: "Label",
            code: "invalid",
            field: "color",
          },
        ],
      }),
      { status: 422 }
    );

    await expect(
      assertLabelCreateSucceeded(
        {
          name: "review:approved",
          color: "not-a-color",
          description: "bad label",
        },
        response
      )
    ).rejects.toThrow("GitHub label create for review:approved failed with 422");
  });

  it("allows successful label creation", async () => {
    const response = new Response("", { status: 201 });

    await expect(
      assertLabelCreateSucceeded(
        {
          name: "review:approved",
          color: "0E8A16",
          description: "Automated review approved this pull request",
        },
        response
      )
    ).resolves.toBeUndefined();
  });
});
