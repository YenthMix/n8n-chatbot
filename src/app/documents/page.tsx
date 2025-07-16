'use client';
import { useRouter } from 'next/navigation';

export default function DocumentsPage() {
  const router = useRouter();

  return (
    <div className="documents-container">
      <div className="documents-header">
        <button 
          className="back-button"
          onClick={() => router.push('/')}
          title="Back to Chat"
        >
          ← Back to Chat
        </button>
        <h1>📄 Document Management</h1>
        <p>Manage documents for your chatbot's knowledge base</p>
      </div>
      
      <div className="documents-content">
        <div className="documents-placeholder">
          <div className="placeholder-icon">📚</div>
          <h2>Document Upload Coming Soon</h2>
          <p>This page will allow you to upload and manage documents for your chatbot's knowledge base.</p>
          
          <div className="feature-list">
            <div className="feature-item">
              <span className="feature-icon">📄</span>
              <span>Upload PDF documents</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">📝</span>
              <span>Add text documents</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">🔍</span>
              <span>Search document database</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">⚙️</span>
              <span>Manage bot knowledge</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
} 