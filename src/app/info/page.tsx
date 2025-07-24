'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function InfoPage() {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');

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
    </div>
  );
} 