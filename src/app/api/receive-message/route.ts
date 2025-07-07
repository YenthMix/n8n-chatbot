import { NextRequest, NextResponse } from 'next/server';

let latestBotMessage: string | null = null;

export async function POST(req: NextRequest) {
  const body = await req.json();
  // Store the latest bot message (adjust key as needed)
  latestBotMessage = body.text || body.message || null;
  return NextResponse.json({ status: 'ok' });
}

export async function GET() {
  return NextResponse.json({ message: latestBotMessage });
} 