/** Shared by execution, polling and recovery so terminal states never regress. */
export function vercelDeploymentStatus(state: string | undefined): "succeeded" | "failed" | "pending" {
  if (state === "READY") return "succeeded";
  if (state === "ERROR" || state === "CANCELED" || state === "BLOCKED") return "failed";
  return "pending";
}
