'use client';
import { useRouter } from 'next/navigation';

export default function InfoPage() {
  const router = useRouter();

  const handleBackToChat = () => {
    router.push('/');
  };

  return (
    <div className="upload-container">
      <button 
        onClick={handleBackToChat}
        className="back-button"
      >
        ← Back to Chat
      </button>

      <div className="upload-content">
        <h1>📄 Upload Document</h1>
        <p style={{ marginBottom: 0 }}>
          This page will soon allow you to upload documents to the knowledge base.<br/>
          (Feature coming soon!)
        </p>
      </div>
    </div>
  );
} 