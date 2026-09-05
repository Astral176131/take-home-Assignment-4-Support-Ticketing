interface Props {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}

/** Shared by the queue and my-tickets so both count and read the same way. */
export function Pagination({ page, totalPages, total, onPage }: Props) {
  return (
    <div className="pagination">
      <button type="button" className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="pagination-status">
        <span>
          Page {page} of {totalPages}
        </span>
        <span>
          {total} ticket{total === 1 ? '' : 's'}
        </span>
      </span>
      <button type="button" className="btn" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
