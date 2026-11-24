import type { CallRow } from '../repo/calls.js';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface SummaryExtract {
  caller_intent: string;
  destination: string | null;
  service: string | null;
  documents_mentioned: string[];
  next_action: string | null;
  follow_up_at: string | null;
  sentiment: Sentiment;
}

export interface SummaryResult {
  summary: string;
  extracted: SummaryExtract;
}

export interface SummaryInput {
  transcript: string;
  language: string | null;
  call: CallRow;
  hints: string[];
}

export interface Summariser {
  readonly name: string;
  readonly model: string;
  summarise(input: SummaryInput): Promise<SummaryResult>;
}
