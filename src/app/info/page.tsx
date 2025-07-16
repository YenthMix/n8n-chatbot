'use client';

export default function InfoPage() {
  const goBack = () => {
    window.location.href = '/';
  };

  return (
    <div className="info-container">
      <div className="info-content">
        <h1>📄 Information Page</h1>
        <p>This is a clean information page with the same beautiful background.</p>
        
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