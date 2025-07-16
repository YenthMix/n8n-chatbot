'use client';

export default function InfoPage() {
  const goBack = () => {
    window.location.href = '/';
  };

  return (
    <div className="info-container">
      <div className="info-content">
        <h1>📄 Add Documents</h1>
        
        <button 
          className="back-button"
          onClick={goBack}
          title="Back to Chat"
        >
          ← Back to Chat
        </button>
      </div>
    </div>
  );
} 