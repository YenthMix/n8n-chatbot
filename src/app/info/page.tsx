'use client';
import { useRouter } from 'next/navigation';

export default function InfoPage() {
  const router = useRouter();

  const handleBackToChat = () => {
    router.push('/');
  };

  return (
    <div className="info-container">
      <div className="info-content">
        <h1>Info Page</h1>
        <p>This is an empty page with the same background.</p>
        
        <button 
          onClick={handleBackToChat}
          className="back-button"
        >
          ← Back to Chat
        </button>
      </div>
    </div>
  );
} 