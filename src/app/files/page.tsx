'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface FileData {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  size?: number;
}

interface SearchResult {
  fileId: string;
  fileName: string;
  content: string;
  score: number;
}

export default function FilesPage() {
  const [files, setFiles] = useState<FileData[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api';

  // Load files on component mount
  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/files`);
      if (response.ok) {
        const data = await response.json();
        setFiles(data.files || []);
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  const uploadFile = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // Convert file to base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64Content = (e.target?.result as string).split(',')[1];
        
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('name', selectedFile.name);
        formData.append('type', selectedFile.type);
        formData.append('content', base64Content);

        const response = await fetch(`${BACKEND_URL}/files/upload`, {
          method: 'POST',
          body: formData
        });

        if (response.ok) {
          const result = await response.json();
          console.log('File uploaded successfully:', result);
          setSelectedFile(null);
          loadFiles(); // Reload file list
        } else {
          console.error('Upload failed:', response.statusText);
        }
        
        setIsUploading(false);
        setUploadProgress(0);
      };

      reader.readAsDataURL(selectedFile);
    } catch (error) {
      console.error('Error uploading file:', error);
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const searchFiles = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const response = await fetch(`${BACKEND_URL}/files/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: searchQuery })
      });

      if (response.ok) {
        const data = await response.json();
        setSearchResults(data.results || []);
      }
    } catch (error) {
      console.error('Error searching files:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const deleteFile = async (fileId: string) => {
    if (!confirm('Are you sure you want to delete this file?')) return;

    try {
      const response = await fetch(`${BACKEND_URL}/files/${fileId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        console.log('File deleted successfully');
        loadFiles(); // Reload file list
      }
    } catch (error) {
      console.error('Error deleting file:', error);
    }
  };

  return (
    <div className="files-container">
      <div className="files-content">
        <div className="files-header">
          <h1>📁 File Management</h1>
          <Link href="/" className="back-button">
            ← Back to Chat
          </Link>
        </div>

        {/* File Upload Section */}
        <div className="upload-section">
          <h2>📤 Upload File</h2>
          <div className="upload-area">
            <input
              type="file"
              onChange={handleFileSelect}
              accept=".pdf,.txt,.doc,.docx,.md"
              className="file-input"
            />
            {selectedFile && (
              <div className="selected-file">
                <span>Selected: {selectedFile.name}</span>
                <button 
                  onClick={uploadFile} 
                  disabled={isUploading}
                  className="upload-button"
                >
                  {isUploading ? 'Uploading...' : 'Upload'}
                </button>
              </div>
            )}
            {isUploading && (
              <div className="upload-progress">
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ width: `${uploadProgress}%` }}
                  ></div>
                </div>
                <span>{uploadProgress}%</span>
              </div>
            )}
          </div>
        </div>

        {/* File Search Section */}
        <div className="search-section">
          <h2>🔍 Search Files</h2>
          <div className="search-area">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Enter your search query..."
              className="search-input"
            />
            <button 
              onClick={searchFiles} 
              disabled={isSearching || !searchQuery.trim()}
              className="search-button"
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </div>
          
          {searchResults.length > 0 && (
            <div className="search-results">
              <h3>Search Results:</h3>
              {searchResults.map((result, index) => (
                <div key={index} className="search-result">
                  <h4>{result.fileName}</h4>
                  <p>{result.content}</p>
                  <span className="score">Score: {result.score.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* File List Section */}
        <div className="files-list-section">
          <h2>📋 Uploaded Files</h2>
          <button onClick={loadFiles} className="refresh-button">
            🔄 Refresh
          </button>
          
          {files.length === 0 ? (
            <p className="no-files">No files uploaded yet.</p>
          ) : (
            <div className="files-list">
              {files.map((file) => (
                <div key={file.id} className="file-item">
                  <div className="file-info">
                    <h4>{file.name}</h4>
                    <p>Type: {file.type}</p>
                    <p>Uploaded: {new Date(file.createdAt).toLocaleDateString()}</p>
                  </div>
                  <button 
                    onClick={() => deleteFile(file.id)}
                    className="delete-button"
                  >
                    🗑️ Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 