'use client';
import Link from 'next/link';

export default function Settings() {
  return (
    <div className="settings-container">
      <div className="settings-content">
        <div className="settings-header">
          <h1>⚙️ Settings</h1>
          <Link href="/" className="back-button">
            ← Back to Chat
          </Link>
        </div>
        
        <div className="settings-body">
          <p>This is a clean settings page. You can add configuration options here.</p>
        </div>
      </div>
    </div>
  );
} 