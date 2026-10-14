import { AppError } from "../errors.js";
import { monthlyBudgetSchema } from "../types/index.js";

export function isWithinBudget(estimatedMonthlyCostUsd: number, maxMonthlyBudgetUsd: number): boolean {
  return monthlyBudgetSchema.parse(estimatedMonthlyCostUsd) <= monthlyBudgetSchema.parse(maxMonthlyBudgetUsd);
}

export function usdToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new AppError("INVALID_BUDGET", "USD amounts must be finite, non-negative and at most 1,000,000.");
  }
  const cents = Math.round(value * 100);
  if (Math.abs(cents / 100 - value) > 1e-8) {
    throw new AppError("INVALID_BUDGET", "USD amounts support at most two decimal places.");
  }
  return cents;
}

export function decimalUsdToCents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new AppError("INVALID_PRICE", "Provider price is not a valid USD decimal.");
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number((fraction as string).padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) {
    throw new AppError("INVALID_PRICE", "Provider price is outside the supported range.");
  }
  return cents;
}
