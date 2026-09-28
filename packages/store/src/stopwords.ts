/** English stop words filtered out of retrieval queries. */
export const stopwords: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
  "at", "by", "for", "with", "about", "into", "to", "from", "of", "on",
  "in", "out", "over", "under", "again", "further", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "i", "me", "my", "we", "our", "you", "your", "he",
  "she", "it", "they", "them", "their", "this", "that", "these",
  "those", "am", "what", "which", "who", "whom", "how", "why", "where",
  "not", "no", "so", "than", "too", "very", "just", "also", "up",
  "down", "any", "each", "there", "here", "all", "get", "got", "does",
]);
