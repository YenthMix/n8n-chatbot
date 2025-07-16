'use client';
import { useState, useRef } from 'react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

export default function InfoPage() {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const goBack = () => {
    window.location.href = '/';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    handleFiles(files);
  };

  const handleFiles = async (files: File[]) => {
    const supportedTypes = [
      'application/pdf',
      'text/html',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/markdown'
    ];

    const validFiles = files.filter(file => {
      const isValidType = supportedTypes.includes(file.type) || 
        file.name.endsWith('.txt') || 
        file.name.endsWith('.md') ||
        file.name.endsWith('.html');
      const isValidSize = file.size <= 100 * 1024 * 1024; // 100MB
      return isValidType && isValidSize;
    });

    if (validFiles.length === 0) {
      setUploadStatus('❌ No valid files selected. Please check file type and size.');
      return;
    }

    setIsUploading(true);
    setUploadStatus(`📤 Uploading ${validFiles.length} file(s)...`);

    for (const file of validFiles) {
      try {
        await uploadFile(file);
      } catch (error) {
        console.error('Upload error:', error);
        setUploadStatus(`❌ Failed to upload ${file.name}`);
      }
    }

    setIsUploading(false);
  };

  const uploadFile = async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${BACKEND_URL}/api/upload-document`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    setUploadedFiles(prev => [...prev, result]);
    setUploadStatus(`✅ Successfully uploaded ${file.name}`);
  };

  return (
    <div className="info-container">
      <div className="info-content">
        <h1>📄 Add Documents</h1>
        <p className="kb-info">
          📚 Files will be uploaded to knowledge base: <strong>kb-bfdcb1988f</strong>
        </p>
        
        <div 
          className={`upload-area ${isDragging ? 'dragging' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="upload-content">
            <div className="upload-icon">📁</div>
            <p className="upload-text">
              Drag and drop some documents here or click to select them
            </p>
            <p className="upload-formats">
              <em>Supported formats (.pdf, .html, .txt, .doc, .docx, .md) (Max file size 100 MB)</em>
            </p>
          </div>
          
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.html,.txt,.doc,.docx,.md"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>

        {uploadStatus && (
          <div className="upload-status">
            {uploadStatus}
          </div>
        )}

        {isUploading && (
          <div className="loading-indicator">
            <div className="spinner"></div>
            Processing...
          </div>
        )}

        {uploadedFiles.length > 0 && (
          <div className="uploaded-files">
            <h3>📚 Uploaded Documents</h3>
            {uploadedFiles.map((file, index) => (
              <div key={index} className="file-item">
                📄 {file.name}
              </div>
            ))}
          </div>
        )}
        
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