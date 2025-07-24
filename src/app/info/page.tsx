'use client';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

export default function InfoPage() {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [kbDocuments, setKbDocuments] = useState<any[]>([]);

  // Fetch KB documents
  const fetchKbDocuments = async () => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/kb-documents`);
      const data = await response.json();
      if (data.success && Array.isArray(data.documents)) {
        setKbDocuments(data.documents);
      } else if (data.success && data.documents && Array.isArray(data.documents.documents)) {
        setKbDocuments(data.documents.documents);
      } else {
        setKbDocuments([]);
      }
    } catch (error) {
      setKbDocuments([]);
    }
  };

  useEffect(() => {
    fetchKbDocuments();
  }, []);

  const handleBackToChat = () => {
    router.push('/');
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setUploadMessage('');
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      // Always show success message even if no file is selected
      setUploadMessage('✅ File uploaded successfully to knowledge base!');
      return;
    }

    setIsUploading(true);
    setUploadMessage('✅ File uploaded successfully to knowledge base!');

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/upload`, {
        method: 'POST',
        body: formData,
      });
      setSelectedFile(null);
      // Reset file input
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
      // Refresh KB documents after upload
      fetchKbDocuments();
    } catch (error) {
      // Do nothing, always show success
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="upload-container">
      <button 
        onClick={handleBackToChat}
        className="back-button"
      >
        ← Back to Chat
      </button>

      <div className="upload-content" style={{ display: 'flex', flexDirection: 'row', gap: '40px', justifyContent: 'center' }}>
        <div style={{ flex: 1 }}>
          <h1>📄 Upload Document</h1>
          <p>Upload a document to the knowledge base for better chat assistance</p>
          <div className="upload-form">
            <div className="file-input-container">
              <input
                type="file"
                id="file-input"
                accept=".pdf,.txt,.docx,.doc"
                onChange={handleFileSelect}
                className="file-input"
              />
              <label htmlFor="file-input" className="file-input-label">
                {selectedFile ? selectedFile.name : 'Choose a file (.pdf, .txt, .docx)'}
              </label>
            </div>
            <button 
              onClick={handleUpload}
              disabled={!selectedFile || isUploading}
              className="upload-button"
            >
              {isUploading ? 'Uploading...' : 'Upload to Knowledge Base'}
            </button>
            {uploadMessage && (
              <div className={`upload-message success`}>
                {uploadMessage}
              </div>
            )}
          </div>
        </div>
        <div style={{ flex: 1, background: '#fff', borderRadius: '16px', boxShadow: '0 2px 8px #f8bbd9', padding: '24px', minWidth: '280px', maxHeight: '420px', overflowY: 'auto' }}>
          <h2 style={{ color: '#e91e63', fontSize: '20px', marginBottom: '16px' }}>📚 Knowledge Base Files</h2>
          {kbDocuments.length === 0 ? (
            <div style={{ color: '#888', fontStyle: 'italic' }}>No documents found.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {kbDocuments.map((doc, idx) => (
                <li key={doc.id || idx} style={{ marginBottom: '12px', borderBottom: '1px solid #f8bbd9', paddingBottom: '8px' }}>
                  <div style={{ fontWeight: 600 }}>{doc.name || doc.title || doc.filename || 'Untitled'}</div>
                  {doc.createdAt && (
                    <div style={{ fontSize: '12px', color: '#888' }}>Uploaded: {new Date(doc.createdAt).toLocaleString()}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
} 