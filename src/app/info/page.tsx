'use client';
import Link from 'next/link';

export default function InfoPage() {
  return (
    <div className="info-container">
      <div className="info-content">
        <h1>ℹ️ Information</h1>
        <p>This is the information page. You can add any content here.</p>
        <Link href="/" className="back-button">
          ← Back to Chat
        </Link>
      </div>
    </div>
  );
} 