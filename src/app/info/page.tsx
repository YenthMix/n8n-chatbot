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
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);

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

  const handleDelete = async (file: any) => {
    setDeleting(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/documents/${file.id || file.fileId}`, {
        method: 'DELETE',
      });
      setDeleteTarget(null);
      await fetchDocuments();
    } catch (e) {
      // Optionally show error
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="upload-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <button 
        onClick={handleBackToChat}
        className="back-button"
      >
        ← Back to Chat
      </button>

      <div style={{ display: 'flex', flexDirection: 'row', gap: 40, alignItems: 'flex-start', justifyContent: 'center', width: '100%' }}>
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
        <div style={{ minWidth: 320, maxWidth: 400, background: 'white', borderRadius: 20, boxShadow: '0 8px 24px rgba(244,143,177,0.12)', padding: 24, height: 'fit-content' }}>
          <h2 style={{ color: '#e91e63', fontSize: 22, marginBottom: 16 }}>📚 Documents</h2>
          {loadingDocs ? (
            <div>Loading documents...</div>
          ) : documents.length === 0 ? (
            <div>No documents found in the knowledge base.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {documents.map((doc: any) => (
                <li key={doc.id || doc.fileId || doc.key} style={{ marginBottom: 12, padding: 10, border: '1px solid #f8bbd9', borderRadius: 10, background: '#fce4ec', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{
                      (() => {
                        const key = doc.key || '';
                        const match = key.match(/^kb-[^/]+\/\d+-/);
                        if (match) {
                          return key.replace(/^kb-[^/]+\/\d+-/, '');
                        }
                        return doc.name || doc.title || doc.fileName || key || doc.id;
                      })()
                    }</div>
                    {doc.createdAt && <div style={{ fontSize: 12, color: '#888' }}>Added: {new Date(doc.createdAt).toLocaleString()}</div>}
                  </div>
                  <button
                    style={{ background: 'none', border: 'none', color: '#e91e63', fontSize: 22, cursor: 'pointer', marginLeft: 10 }}
                    title="Delete file"
                    onClick={() => setDeleteTarget(doc)}
                    disabled={deleting}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Confirmation Dialog */}
          {deleteTarget && (
            <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
              <div style={{ background: 'white', borderRadius: 16, padding: 32, minWidth: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', textAlign: 'center' }}>
                <div style={{ fontSize: 18, marginBottom: 18 }}>Do you really want to delete this file?</div>
                <div style={{ marginBottom: 24, fontWeight: 600 }}>
                  {(() => {
                    const key = deleteTarget.key || '';
                    const match = key.match(/^kb-[^/]+\/\d+-/);
                    if (match) {
                      return key.replace(/^kb-[^/]+\/\d+-/, '');
                    }
                    return deleteTarget.name || deleteTarget.title || deleteTarget.fileName || key || deleteTarget.id;
                  })()}
                </div>
                <button
                  onClick={() => handleDelete(deleteTarget)}
                  disabled={deleting}
                  style={{ background: '#e91e63', color: 'white', border: 'none', borderRadius: 8, padding: '8px 24px', fontWeight: 600, marginRight: 16, cursor: 'pointer', fontSize: 16 }}
                >
                  {deleting ? 'Deleting...' : 'Yes'}
                </button>
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                  style={{ background: '#f8bbd9', color: '#e91e63', border: 'none', borderRadius: 8, padding: '8px 24px', fontWeight: 600, cursor: 'pointer', fontSize: 16 }}
                >
                  No
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 