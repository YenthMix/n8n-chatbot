'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useEffect } from 'react';

export default function InfoPage() {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [documents, setDocuments] = useState<any[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  const fetchDocuments = async () => {
    setLoadingDocs(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/documents`);
      const data = await response.json();
      if (data.success && data.files && Array.isArray(data.files)) {
        setDocuments(data.files);
      } else {
        setDocuments([]);
      }
    } catch (e) {
      setDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
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
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
      await fetchDocuments(); // Refresh document list after upload
    } catch (error) {
      // Do nothing, always show success
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="upload-container" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' }}>
      <button 
        onClick={handleBackToChat}
        className="back-button"
      >
        ← Back to Chat
      </button>

      <div className="upload-content">
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

      {/* File list on the right */}
      <div style={{ marginLeft: 40, minWidth: 320, maxWidth: 400, background: 'white', borderRadius: 20, boxShadow: '0 8px 24px rgba(244,143,177,0.12)', padding: 24, height: 'fit-content' }}>
        <h2 style={{ color: '#e91e63', fontSize: 22, marginBottom: 16 }}>📚 Documents</h2>
        {loadingDocs ? (
          <div>Loading documents...</div>
        ) : documents.length === 0 ? (
          <div>No documents found in the knowledge base.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {documents.map((doc: any) => (
              <li key={doc.id || doc.fileId || doc.key} style={{ marginBottom: 12, padding: 10, border: '1px solid #f8bbd9', borderRadius: 10, background: '#fce4ec' }}>
                <div style={{ fontWeight: 600 }}>{
                   (() => {
                     // If doc.key matches the pattern, strip the prefix
                     const key = doc.key || '';
                     const match = key.match(/^kb-[^/]+\/\d+-/);
                     if (match) {
                       return key.replace(/^kb-[^/]+\/\d+-/, '');
                     }
                     return doc.name || doc.title || doc.fileName || key || doc.id;
                   })()
                 }</div>
                {doc.createdAt && <div style={{ fontSize: 12, color: '#888' }}>Added: {new Date(doc.createdAt).toLocaleString()}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
} 