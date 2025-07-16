'use client';
import { useRouter } from 'next/navigation';

export default function InfoPage() {
  const router = useRouter();

  const handleBackToChat = () => {
    router.push('/');
  };

  return (
    <div className="info-container">
      <button 
        onClick={handleBackToChat}
        className="back-button"
      >
        ← Back to Chat
      </button>
    </div>
  );
} 