import { Link } from 'react-router-dom';
const labels = { original_mock: '原创模拟', official_sample: '官方样题', past_paper: '真题' };

export function QuestionSource({ question }) {
  const source = question?.provenance;
  const questionId = question?.id || question?.questionId;
  const correction = questionId ? <Link target="_blank" rel="noopener noreferrer" to={`/support?category=other&questionId=${encodeURIComponent(questionId)}`}>题目纠错</Link> : null;
  if (!source) return <p className="question-source-note">题源：历史记录未包含来源信息 {correction}</p>;
  const url = /^https?:\/\//i.test(source.sourceUrl || '') ? source.sourceUrl : '';
  return <div className="question-source-note">
    <span className={`question-source-badge ${source.contentKind || 'unknown'}`}>{labels[source.contentKind] || source.label || '来源待核验'}</span>
    {[source.year ? `${source.year} 年` : '', source.region, source.questionNumber ? `第 ${source.questionNumber} 题` : ''].filter(Boolean).join(' · ')}
    {source.sourceTitle && <span>{source.sourceTitle}</span>}
    {url && <a href={url} target="_blank" rel="noopener noreferrer">查看来源 ↗</a>}
    {correction}
  </div>;
}
