/**
 * Loads and validates the seed CSVs from assets/seed-data.
 * Parsing is strict: a malformed seed file fails loudly.
 */
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Customer, Payout, Transaction } from "./types.js";

const CustomerSchema = z.object({
  customer_id: z.string().min(1),
  company_name: z.string().min(1),
  contact_name: z.string().min(1),
  contact_email: z.string().email(),
  plan: z.string().min(1),
  account_status: z.string().min(1),
  region: z.string().min(1),
  kyc_status: z.string().min(1),
  support_notes: z.string(),
});

const TransactionSchema = z.object({
  transaction_id: z.string().min(1),
  customer_id: z.string().min(1),
  transaction_type: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
  destination_country: z.string().min(1),
  status: z.string().min(1),
  created_at: z.string().min(1),
  estimated_arrival: z.string(),
  support_summary: z.string().min(1),
});

const PayoutSchema = z.object({
  payout_id: z.string().min(1),
  transaction_id: z.string().min(1),
  customer_id: z.string().min(1),
  recipient_name: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
  status: z.string().min(1),
  scheduled_for: z.string().min(1),
  failure_reason: z.string(),
});

export function parseCustomersCsv(csv: string): Customer[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as unknown[];
  return rows.map((row) => {
    const rec = CustomerSchema.parse(row);
    return { ...rec };
  });
}

export function parseTransactionsCsv(csv: string): Transaction[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as unknown[];
  return rows.map((row) => {
    const rec = TransactionSchema.parse(row);
    return {
      ...rec,
      estimated_arrival: rec.estimated_arrival.trim() === "" ? null : rec.estimated_arrival,
    };
  });
}

export function parsePayoutsCsv(csv: string): Payout[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as unknown[];
  return rows.map((row) => {
    const rec = PayoutSchema.parse(row);
    return {
      ...rec,
      failure_reason: rec.failure_reason.trim() === "" ? null : rec.failure_reason,
    };
  });
}

export interface SeedFiles {
  customers: Customer[];
  transactions: Transaction[]; 
  payouts: Payout[];
}

export function loadSeedData(dir: string): SeedFiles {
  const customers = parseCustomersCsv(readFileSync(`${dir}/customers.csv`, "utf8"));
  const transactions = parseTransactionsCsv(readFileSync(`${dir}/transactions.csv`, "utf8"));
  const payouts = parsePayoutsCsv(readFileSync(`${dir}/payouts.csv`, "utf8"));
  return { customers, transactions, payouts };
}
