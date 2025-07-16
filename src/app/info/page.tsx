'use client';
import { useRouter } from 'next/navigation';

export default function InfoPage() {
  const router = useRouter();

  const handleBackToChat = () => {
    router.push('/');
  };

  return (
    <button 
      onClick={handleBackToChat}
      className="back-button"
    >
      ← Back to Chat
    </button>
  );
} 